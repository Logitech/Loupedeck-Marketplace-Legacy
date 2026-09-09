import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const REGISTRY_PATH = path.join(ROOT, "data", "marketplaces.json");
const DEFAULT_TIMEOUT_MS = 60_000;
const HASH_CSV_COLUMNS = [
  "marketplaceId",
  "packageName",
  "displayName",
  "releaseAssetFileName",
  "sourceInstallationFile",
  "sizeBytes",
  "sha256",
  "downloadedAt",
];

function parseArgs(argv) {
  const options = {
    marketplaceId: "v59",
    force: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };

  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--force") {
      options.force = true;
      continue;
    }

    if (arg === "--timeout-ms") {
      const value = Number(argv[index + 1]);
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error("--timeout-ms must be followed by a positive number");
      }

      options.timeoutMs = value;
      index += 1;
      continue;
    }

    if (arg.startsWith("--timeout-ms=")) {
      const value = Number(arg.slice("--timeout-ms=".length));
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error("--timeout-ms must be a positive number");
      }

      options.timeoutMs = value;
      continue;
    }

    if (arg.startsWith("--")) {
      throw new Error(`Unknown option: ${arg}`);
    }

    positional.push(arg);
  }

  if (positional.length > 1) {
    throw new Error("Usage: node tools/marketplace/download-packages.mjs [marketplaceId] [--force] [--timeout-ms N]");
  }

  if (positional[0]) {
    options.marketplaceId = positional[0];
  }

  return options;
}

function resolveMarketplace(registry, marketplaceId) {
  const config = Array.isArray(registry)
    ? registry.find((entry) => entry.id === marketplaceId)
    : registry[marketplaceId];

  if (!config) {
    throw new Error(`Marketplace "${marketplaceId}" was not found in data/marketplaces.json`);
  }

  return config;
}

async function readJson(filePath, label) {
  try {
    return JSON.parse(await fsp.readFile(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Could not read ${label} at ${path.relative(ROOT, filePath)}: ${error.message}`);
  }
}

function fileNameFromUrl(value) {
  if (!value) {
    return null;
  }

  try {
    const url = new URL(value);
    const basename = decodeURIComponent(url.pathname.split("/").filter(Boolean).pop() || "");
    return basename || null;
  } catch {
    const basename = decodeURIComponent(String(value).split(/[?#]/)[0].split("/").pop() || "");
    return basename || null;
  }
}

function sanitizeReleaseFileName(value) {
  if (!value) {
    return null;
  }

  return value
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/[.\s]+$/g, "")
    .trim();
}

function releaseDownloadUrl(marketplace, fileName) {
  if (!fileName) {
    return null;
  }

  const baseUrl = marketplace.releaseDownloadBaseUrl?.replace(/\/+$/, "");
  if (!baseUrl || !marketplace.releaseTag) {
    return null;
  }

  return `${baseUrl}/${encodeURIComponent(marketplace.releaseTag)}/${encodeURIComponent(fileName)}`;
}

function csvEscape(value) {
  const text = value === null || value === undefined ? "" : String(value);

  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }

  return text;
}

function parseCsvLine(line) {
  const values = [];
  let value = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];

    if (inQuotes) {
      if (char === '"' && line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        value += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      values.push(value);
      value = "";
    } else {
      value += char;
    }
  }

  values.push(value);
  return values;
}

async function readHashCsv(filePath) {
  try {
    const text = await fsp.readFile(filePath, "utf8");
    const lines = text.trim().split(/\r?\n/).filter(Boolean);
    if (lines.length === 0) {
      return new Map();
    }

    const headers = parseCsvLine(lines[0]);
    const byFileName = new Map();
    for (const line of lines.slice(1)) {
      const values = parseCsvLine(line);
      const row = Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""]));

      if (row.releaseAssetFileName) {
        byFileName.set(row.releaseAssetFileName.toLowerCase(), row);
      }
    }

    return byFileName;
  } catch (error) {
    if (error.code === "ENOENT") {
      return new Map();
    }

    throw error;
  }
}

async function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  let sizeBytes = 0;

  for await (const chunk of fs.createReadStream(filePath)) {
    sizeBytes += chunk.length;
    hash.update(chunk);
  }

  return {
    sizeBytes,
    sha256: hash.digest("hex"),
  };
}

async function downloadFile(url, outputPath, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const temporaryPath = `${outputPath}.tmp-${process.pid}-${Date.now()}`;
  const hash = crypto.createHash("sha256");
  let sizeBytes = 0;

  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": "Loupedeck-Marketplace-Legacy/1.0",
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }

    if (!response.body) {
      throw new Error("Response did not include a body");
    }

    await pipeline(
      Readable.fromWeb(response.body),
      new Transform({
        transform(chunk, _encoding, callback) {
          sizeBytes += chunk.length;
          hash.update(chunk);
          callback(null, chunk);
        },
      }),
      fs.createWriteStream(temporaryPath, { flags: "wx" }),
    );

    await fsp.rename(temporaryPath, outputPath);

    return {
      sizeBytes,
      sha256: hash.digest("hex"),
      finalUrl: response.url,
    };
  } catch (error) {
    await fsp.rm(temporaryPath, { force: true }).catch(() => {});
    if (error.name === "AbortError") {
      throw new Error(`Timed out after ${timeoutMs}ms`);
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function knownHashForRecord(record, existingHashRows) {
  const csvRecord = existingHashRows.get(String(record.releaseAssetFileName || "").toLowerCase());
  const sizeBytes = Number(record.sizeBytes ?? csvRecord?.sizeBytes);
  const sha256 = String(record.sha256 || csvRecord?.sha256 || "").trim().toLowerCase();

  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0 || !/^[a-f0-9]{64}$/.test(sha256)) {
    return null;
  }

  return { sizeBytes, sha256 };
}

function buildHashRows(records, downloadedAtByFileName) {
  return records
    .map((record) => ({
      marketplaceId: record.marketplaceId,
      packageName: record.packageName,
      displayName: record.displayName,
      releaseAssetFileName: record.releaseAssetFileName,
      sourceInstallationFile: record.sourceInstallationFile,
      sizeBytes: record.sizeBytes,
      sha256: record.sha256,
      downloadedAt: downloadedAtByFileName.get(record.releaseAssetFileName.toLowerCase()) || "",
    }))
    .sort((a, b) => a.releaseAssetFileName.localeCompare(b.releaseAssetFileName));
}

async function writeHashCsv(filePath, records, downloadedAtByFileName) {
  const rows = buildHashRows(records, downloadedAtByFileName);
  const lines = [
    HASH_CSV_COLUMNS.join(","),
    ...rows.map((row) => HASH_CSV_COLUMNS.map((column) => csvEscape(row[column])).join(",")),
  ];

  await fsp.writeFile(filePath, `${lines.join("\n")}\n`);
}

function formatBytes(value) {
  return new Intl.NumberFormat("en-US").format(value);
}

const options = parseArgs(process.argv.slice(2));
const registry = await readJson(REGISTRY_PATH, "marketplace registry");
const marketplace = resolveMarketplace(registry, options.marketplaceId);
const dataDir = path.join(ROOT, marketplace.dataDir || path.join("data", marketplace.id));
const manifestPath = path.join(dataDir, "manifest.json");
const hashCsvPath = path.join(dataDir, "file-hashes.csv");
const packageDir = path.join(ROOT, "working", "packages", marketplace.id);
const manifest = await readJson(manifestPath, "manifest");

if (!Array.isArray(manifest.assets)) {
  throw new Error(`${path.relative(ROOT, manifestPath)} must contain an assets array`);
}

const existingHashRows = await readHashCsv(hashCsvPath);
const publishableRecords = manifest.assets.filter((record) => record.sourceInstallationFile);

for (const record of publishableRecords) {
  const derivedFileName = sanitizeReleaseFileName(record.releaseAssetFileName || fileNameFromUrl(record.sourceInstallationFile));
  if (!derivedFileName) {
    throw new Error(`Could not derive a release filename for ${record.packageName || record.displayName || "unknown record"}`);
  }

  record.releaseAssetFileName = derivedFileName;
  record.releaseDownloadUrl = releaseDownloadUrl(marketplace, derivedFileName);
}

const recordsByFileName = new Map();
for (const record of publishableRecords) {
  const key = record.releaseAssetFileName.toLowerCase();
  if (!recordsByFileName.has(key)) {
    recordsByFileName.set(key, []);
  }

  recordsByFileName.get(key).push(record);
}

const duplicateFileNames = [...recordsByFileName.values()].filter((records) => records.length > 1);
if (duplicateFileNames.length) {
  const details = duplicateFileNames
    .map((records) => `${records[0].releaseAssetFileName}: ${records.map((record) => record.packageName).join(", ")}`)
    .join("\n");
  throw new Error(`Duplicate release asset filenames found:\n${details}`);
}

await fsp.mkdir(packageDir, { recursive: true });

const stats = {
  downloaded: 0,
  skipped: 0,
  hashedExisting: 0,
  failed: 0,
  totalBytes: 0,
};
const failedRecords = [];
const completedRecords = [];
const downloadedAtByFileName = new Map();

for (const [index, record] of publishableRecords.entries()) {
  const relativeOutputPath = path.join("working", "packages", marketplace.id, record.releaseAssetFileName).replace(/\\/g, "/");
  const outputPath = path.join(packageDir, record.releaseAssetFileName);
  const knownHash = knownHashForRecord(record, existingHashRows);
  const now = new Date().toISOString();

  try {
    const fileStat = await fsp.stat(outputPath).catch((error) => {
      if (error.code === "ENOENT") {
        return null;
      }

      throw error;
    });

    if (!options.force && fileStat && knownHash && fileStat.size === knownHash.sizeBytes) {
      record.sizeBytes = knownHash.sizeBytes;
      record.sha256 = knownHash.sha256;
      record.releaseDownloadUrl = releaseDownloadUrl(marketplace, record.releaseAssetFileName);
      downloadedAtByFileName.set(
        record.releaseAssetFileName.toLowerCase(),
        existingHashRows.get(record.releaseAssetFileName.toLowerCase())?.downloadedAt || "",
      );
      stats.skipped += 1;
      stats.totalBytes += knownHash.sizeBytes;
      completedRecords.push(record);
      console.log(`[${index + 1}/${publishableRecords.length}] skipped ${relativeOutputPath}`);
      continue;
    }

    if (!options.force && fileStat) {
      const hashResult = await sha256File(outputPath);
      record.sizeBytes = hashResult.sizeBytes;
      record.sha256 = hashResult.sha256;
      record.releaseDownloadUrl = releaseDownloadUrl(marketplace, record.releaseAssetFileName);
      downloadedAtByFileName.set(
        record.releaseAssetFileName.toLowerCase(),
        existingHashRows.get(record.releaseAssetFileName.toLowerCase())?.downloadedAt || "",
      );
      stats.hashedExisting += 1;
      stats.totalBytes += hashResult.sizeBytes;
      completedRecords.push(record);
      console.log(`[${index + 1}/${publishableRecords.length}] hashed existing ${relativeOutputPath}`);
      continue;
    }

    const downloadResult = await downloadFile(record.sourceInstallationFile, outputPath, options.timeoutMs);
    record.sizeBytes = downloadResult.sizeBytes;
    record.sha256 = downloadResult.sha256;
    record.releaseDownloadUrl = releaseDownloadUrl(marketplace, record.releaseAssetFileName);
    downloadedAtByFileName.set(record.releaseAssetFileName.toLowerCase(), now);
    stats.downloaded += 1;
    stats.totalBytes += downloadResult.sizeBytes;
    completedRecords.push(record);
    console.log(
      `[${index + 1}/${publishableRecords.length}] downloaded ${relativeOutputPath} (${formatBytes(downloadResult.sizeBytes)} bytes)`,
    );
  } catch (error) {
    stats.failed += 1;
    failedRecords.push({
      packageName: record.packageName,
      displayName: record.displayName,
      releaseAssetFileName: record.releaseAssetFileName,
      sourceInstallationFile: record.sourceInstallationFile,
      error: error.message,
    });
    console.error(`[${index + 1}/${publishableRecords.length}] failed ${relativeOutputPath}: ${error.message}`);
  }
}

for (const record of manifest.assets) {
  delete record.downloadedAt;
}

await writeHashCsv(hashCsvPath, completedRecords, downloadedAtByFileName);
await fsp.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

console.log("");
console.log(`Wrote ${path.relative(ROOT, hashCsvPath).replace(/\\/g, "/")}`);
console.log(`Updated ${path.relative(ROOT, manifestPath).replace(/\\/g, "/")}`);
console.log(
  `Summary: ${stats.downloaded} downloaded, ${stats.skipped} skipped, ${stats.hashedExisting} hashed existing, ${stats.failed} failed, ${formatBytes(stats.totalBytes)} bytes`,
);

if (failedRecords.length) {
  console.log("");
  console.log("Failures:");
  for (const failure of failedRecords) {
    console.log(
      `- ${failure.releaseAssetFileName} (${failure.packageName || failure.displayName}): ${failure.error} from ${failure.sourceInstallationFile}`,
    );
  }

  process.exitCode = 1;
}
