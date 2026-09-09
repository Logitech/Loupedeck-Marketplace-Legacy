import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const REGISTRY_PATH = path.join(ROOT, "data", "marketplaces.json");
const CORE_REQUIRED_FIELDS = [
  "marketplaceId",
  "packageName",
  "displayName",
  "type",
  "version",
  "sources",
];
const PUBLISH_REQUIRED_FIELDS = ["releaseAssetFileName", "releaseDownloadUrl", "sha256"];
const BLOCKING_FLAGS = new Set([
  "missing-catalog-record",
  "missing-package-record",
  "missing-installation-file",
  "duplicate-output-filename",
]);

function resolveMarketplace(registry, marketplaceId) {
  const config = Array.isArray(registry)
    ? registry.find((entry) => entry.id === marketplaceId)
    : registry[marketplaceId];

  if (!config) {
    throw new Error(`Marketplace "${marketplaceId}" was not found in data/marketplaces.json`);
  }

  return config;
}

function normalizeKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function escapeMarkdown(value) {
  return String(value ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ")
    .trim();
}

function formatValue(value) {
  if (value === null || value === undefined || value === "") {
    return "-";
  }

  if (Array.isArray(value)) {
    return value.length > 0 ? value.join(", ") : "-";
  }

  return String(value);
}

function table(headers, rows) {
  const lines = [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map((header) => (/:$/.test(header) ? "---:" : "---")).join(" | ")} |`,
  ];

  for (const row of rows) {
    lines.push(`| ${row.map((value) => escapeMarkdown(formatValue(value))).join(" | ")} |`);
  }

  return lines;
}

function countBy(records, keyFn) {
  const counts = new Map();

  for (const record of records) {
    const key = keyFn(record) || "unknown";
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  return [...counts].sort((a, b) => a[0].localeCompare(b[0]));
}

function recordsWithFlag(records, flag) {
  return records.filter((record) => (record.reviewFlags || []).includes(flag));
}

function recordSummary(record) {
  return [
    record.packageName,
    record.displayName,
    record.type,
    record.version,
    record.installationLink,
    record.releaseAssetFileName,
  ];
}

async function readJson(filePath, label) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Could not read ${label} at ${path.relative(ROOT, filePath)}: ${error.message}`);
  }
}

async function readPluginVersionMatrix() {
  const matrixPath = path.join(ROOT, "plugin-version-matrix.tsv");

  try {
    const text = await fs.readFile(matrixPath, "utf8");
    const [headerLine, ...lines] = text.trim().split(/\r?\n/);
    const headers = headerLine.split("\t");
    const packageIndex = headers.indexOf("packagename");
    const versionIndex = headers.indexOf("5.9");

    if (packageIndex === -1 || versionIndex === -1) {
      return null;
    }

    const rows = new Map();
    for (const line of lines) {
      const columns = line.split("\t");
      const packageName = columns[packageIndex];
      const version = columns[versionIndex];

      if (!packageName || !version || version === "-") {
        continue;
      }

      rows.set(normalizeKey(packageName), { packageName, version });
    }

    return rows;
  } catch {
    return null;
  }
}

function comparePluginMatrix(assets, matrixRows) {
  if (!matrixRows) {
    return null;
  }

  const manifestPlugins = new Map(
    assets
      .filter((record) => record.type === "plugin")
      .map((record) => [normalizeKey(record.packageName), record]),
  );

  const missingFromManifest = [...matrixRows.values()].filter(
    (row) => !manifestPlugins.has(normalizeKey(row.packageName)),
  );
  const missingFromMatrix = [...manifestPlugins.values()].filter(
    (record) => !matrixRows.has(normalizeKey(record.packageName)),
  );
  const versionMismatches = [...manifestPlugins.values()]
    .map((record) => {
      const matrixRow = matrixRows.get(normalizeKey(record.packageName));
      if (!matrixRow) {
        return null;
      }

      const matrixVersion = matrixRow.version.replace(/^v/i, "");
      const manifestVersion = String(record.version || "").replace(/^v/i, "");

      return matrixVersion === manifestVersion
        ? null
        : {
            packageName: record.packageName,
            displayName: record.displayName,
            manifestVersion: record.version,
            matrixVersion: matrixRow.version,
          };
    })
    .filter(Boolean);

  return {
    matrixRows: matrixRows.size,
    manifestPlugins: manifestPlugins.size,
    missingFromManifest,
    missingFromMatrix,
    versionMismatches,
  };
}

const marketplaceId = process.argv[2] || "v59";
const registry = await readJson(REGISTRY_PATH, "marketplace registry");
const marketplace = resolveMarketplace(registry, marketplaceId);
const outputDir = path.join(ROOT, marketplace.dataDir || path.join("data", marketplaceId));
const manifestPath = path.join(outputDir, "manifest.json");
const reportPath = path.join(outputDir, "validation-report.md");
const manifest = await readJson(manifestPath, "manifest");
const assets = manifest.assets || [];

if (!Array.isArray(assets)) {
  throw new Error(`${path.relative(ROOT, manifestPath)} must contain an assets array`);
}

const structuralIssues = [];
for (const [index, record] of assets.entries()) {
  for (const field of CORE_REQUIRED_FIELDS) {
    const value = record[field];
    if (field === "sources") {
      if (!Array.isArray(value) || value.length === 0) {
        structuralIssues.push({ index, packageName: record.packageName, field });
      }
      continue;
    }

    if (value === undefined || value === null || value === "") {
      structuralIssues.push({ index, packageName: record.packageName, field });
    }
  }
}

const allFlags = [...new Set(assets.flatMap((record) => record.reviewFlags || []))].sort();
const blockingRecords = assets.filter((record) =>
  (record.reviewFlags || []).some((flag) => BLOCKING_FLAGS.has(flag)),
);
const publishCandidateRecords = assets.filter(
  (record) => record.sourceInstallationFile && !(record.reviewFlags || []).some((flag) => BLOCKING_FLAGS.has(flag)),
);
const publishFieldIssues = [];
for (const record of publishCandidateRecords) {
  for (const field of PUBLISH_REQUIRED_FIELDS) {
    const value = record[field];
    if (value === undefined || value === null || value === "") {
      publishFieldIssues.push({ packageName: record.packageName, displayName: record.displayName, field });
    }
  }
}
const hiddenForMissingFile = assets.filter((record) => !record.sourceInstallationFile);
const catalogWithoutPackage = recordsWithFlag(assets, "missing-package-record");
const packageWithoutCatalog = recordsWithFlag(assets, "missing-catalog-record");
const matrixComparison = comparePluginMatrix(assets, await readPluginVersionMatrix());
const generatedAt = new Date().toISOString();
const lines = [
  `# ${marketplace.title} validation report`,
  "",
  `Generated: ${generatedAt}`,
  "",
  "## Summary",
  "",
  ...table(
    ["Metric", "Count:"],
    [
      ["Catalog source records", manifest.counts?.catalogRecords ?? "-"],
      ["Package source records", manifest.counts?.packageRecords ?? "-"],
      ["Manifest records", assets.length],
      ["Records with source installation files", assets.filter((record) => record.sourceInstallationFile).length],
      ["Records without source installation files", hiddenForMissingFile.length],
      ["Records with review flags", assets.filter((record) => (record.reviewFlags || []).length > 0).length],
      ["Records with blocking flags", blockingRecords.length],
      ["Core manifest field issues", structuralIssues.length],
      ["Publish candidate field gaps", publishFieldIssues.length],
    ],
  ),
  "",
  "## Totals by asset type",
  "",
  ...table(["Type", "Count:"], countBy(assets, (record) => record.type)),
  "",
  "## Review flag counts",
  "",
  ...(allFlags.length
    ? table(
        ["Flag", "Count:"],
        allFlags.map((flag) => [flag, recordsWithFlag(assets, flag).length]),
      )
    : ["No review flags found."]),
  "",
];

for (const flag of allFlags) {
  const flaggedRecords = recordsWithFlag(assets, flag);
  lines.push(`## ${flag}`, "");
  lines.push(
    ...table(
      ["Package name", "Display name", "Type", "Version", "Installation link", "Release file"],
      flaggedRecords.map(recordSummary),
    ),
    "",
  );
}

lines.push(
  "## Catalog records with no package match",
  "",
  ...(catalogWithoutPackage.length
    ? table(
        ["Package name", "Display name", "Type", "Version", "Installation link", "Release file"],
        catalogWithoutPackage.map(recordSummary),
      )
    : ["None."]),
  "",
  "## Package records with no catalog match",
  "",
  ...(packageWithoutCatalog.length
    ? table(
        ["Package name", "Display name", "Type", "Version", "Installation link", "Release file"],
        packageWithoutCatalog.map(recordSummary),
      )
    : ["None."]),
  "",
  "## Hidden until a source installation file is available",
  "",
  ...(hiddenForMissingFile.length
    ? table(
        ["Package name", "Display name", "Type", "Version", "Installation link", "Release file"],
        hiddenForMissingFile.map(recordSummary),
      )
    : ["None."]),
  "",
);

if (structuralIssues.length) {
  lines.push(
    "## Core manifest field issues",
    "",
    ...table(
      ["Manifest index", "Package name", "Missing field"],
      structuralIssues.map((issue) => [issue.index, issue.packageName, issue.field]),
    ),
    "",
  );
}

if (publishFieldIssues.length) {
  lines.push(
    "## Publish candidate field gaps",
    "",
    "These records have a source installation file and no blocking review flag, but are missing fields required before publishing release-backed downloads. Missing `sha256` is expected until the package download/hash phase runs.",
    "",
    ...table(
      ["Package name", "Display name", "Missing field"],
      publishFieldIssues.map((issue) => [issue.packageName, issue.displayName, issue.field]),
    ),
    "",
  );
}

lines.push("## Plugin version matrix comparison", "");

if (!matrixComparison) {
  lines.push("`plugin-version-matrix.tsv` was not present or did not contain the expected columns.", "");
} else {
  lines.push(
    ...table(
      ["Metric", "Count:"],
      [
        ["Plugin matrix v5.9 rows", matrixComparison.matrixRows],
        ["Manifest plugin rows", matrixComparison.manifestPlugins],
        ["Matrix plugins missing from manifest", matrixComparison.missingFromManifest.length],
        ["Manifest plugins missing from matrix", matrixComparison.missingFromMatrix.length],
        ["Version mismatches", matrixComparison.versionMismatches.length],
      ],
    ),
    "",
  );

  if (matrixComparison.missingFromManifest.length) {
    lines.push(
      "### Matrix plugins missing from manifest",
      "",
      ...table(
        ["Package name", "Matrix v5.9 version"],
        matrixComparison.missingFromManifest.map((row) => [row.packageName, row.version]),
      ),
      "",
    );
  }

  if (matrixComparison.missingFromMatrix.length) {
    lines.push(
      "### Manifest plugins missing from matrix",
      "",
      ...table(
        ["Package name", "Display name", "Manifest version"],
        matrixComparison.missingFromMatrix.map((record) => [
          record.packageName,
          record.displayName,
          record.version,
        ]),
      ),
      "",
    );
  }

  if (matrixComparison.versionMismatches.length) {
    lines.push(
      "### Version mismatches",
      "",
      ...table(
        ["Package name", "Display name", "Manifest version", "Matrix v5.9 version"],
        matrixComparison.versionMismatches.map((record) => [
          record.packageName,
          record.displayName,
          record.manifestVersion,
          record.matrixVersion,
        ]),
      ),
      "",
    );
  }
}

await fs.writeFile(reportPath, `${lines.join("\n")}\n`);

console.log(`Wrote validation report to ${path.relative(ROOT, reportPath).replace(/\\/g, "/")}`);
console.log(`${assets.length} manifest records, ${blockingRecords.length} records with blocking review flags`);

if (structuralIssues.length) {
  process.exitCode = 1;
}
