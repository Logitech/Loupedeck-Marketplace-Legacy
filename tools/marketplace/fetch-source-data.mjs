import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const REGISTRY_PATH = path.join(ROOT, "data", "marketplaces.json");
const USER_AGENT = "loupedeck-marketplace-v59-migration/1.0";

function resolveMarketplace(registry, marketplaceId) {
  const config = Array.isArray(registry)
    ? registry.find((entry) => entry.id === marketplaceId)
    : registry[marketplaceId];

  if (!config) {
    throw new Error(`Marketplace "${marketplaceId}" was not found in data/marketplaces.json`);
  }

  return config;
}

function request(url, redirectCount = 0) {
  if (redirectCount > 5) {
    throw new Error(`Too many redirects while fetching ${url}`);
  }

  return new Promise((resolve, reject) => {
    const client = url.startsWith("http://") ? http : https;

    const req = client.get(
      url,
      {
        headers: {
          "user-agent": USER_AGENT,
          accept: "application/json",
        },
      },
      (response) => {
        const statusCode = response.statusCode || 0;
        const location = response.headers.location;

        if (statusCode >= 300 && statusCode < 400 && location) {
          response.resume();
          resolve(request(new URL(location, url).toString(), redirectCount + 1));
          return;
        }

        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const body = Buffer.concat(chunks);
          resolve({ body, response });
        });
      },
    );

    req.on("error", reject);
    req.setTimeout(60_000, () => {
      req.destroy(new Error(`Timed out while fetching ${url}`));
    });
  });
}

function assertJsonArray(body, label) {
  let parsed;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch (error) {
    throw new Error(`${label} did not return valid JSON: ${error.message}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`${label} response was JSON, but not an array`);
  }

  if (parsed.length === 0) {
    throw new Error(`${label} response was an empty array`);
  }

  return parsed;
}

async function fetchSource(marketplaceId, sourceKey, sourceConfig, outputDir) {
  const fetchedAt = new Date().toISOString();
  const { body, response } = await request(sourceConfig.url);
  const statusCode = response.statusCode || 0;

  if (statusCode < 200 || statusCode >= 300) {
    throw new Error(`${sourceConfig.url} returned HTTP ${statusCode}`);
  }

  const parsed = assertJsonArray(body, sourceKey);
  const outputPath = path.join(outputDir, sourceConfig.fileName);
  await fs.writeFile(outputPath, body);

  return {
    sourceKey,
    sourceId: sourceConfig.id || `${marketplaceId}-${sourceKey}`,
    url: sourceConfig.url,
    statusCode,
    contentType: response.headers["content-type"] || null,
    contentLengthHeader: response.headers["content-length"] || null,
    bodyLengthBytes: body.length,
    sha256: crypto.createHash("sha256").update(body).digest("hex"),
    recordCount: parsed.length,
    fetchedAt,
    outputPath: path.relative(ROOT, outputPath).replace(/\\/g, "/"),
  };
}

const marketplaceId = process.argv[2] || "v59";
const registry = JSON.parse(await fs.readFile(REGISTRY_PATH, "utf8"));
const marketplace = resolveMarketplace(registry, marketplaceId);
const outputDir = path.join(ROOT, marketplace.workingSourceDir || "working/source");
const metadataPath = path.join(outputDir, `${marketplaceId}-source-metadata.json`);

if (!marketplace.sources?.catalog || !marketplace.sources?.packages) {
  throw new Error(`Marketplace "${marketplaceId}" must define sources.catalog and sources.packages`);
}

await fs.mkdir(outputDir, { recursive: true });

const sources = {};
for (const [sourceKey, sourceConfig] of Object.entries(marketplace.sources)) {
  const metadata = await fetchSource(marketplaceId, sourceKey, sourceConfig, outputDir);
  sources[sourceKey] = metadata;
  console.log(
    `Fetched ${sourceKey}: ${metadata.recordCount} records, ${metadata.bodyLengthBytes} bytes, sha256 ${metadata.sha256}`,
  );
}

await fs.writeFile(
  metadataPath,
  `${JSON.stringify(
    {
      marketplaceId,
      fetchedAt: new Date().toISOString(),
      sources,
    },
    null,
    2,
  )}\n`,
);

console.log(`Wrote source metadata to ${path.relative(ROOT, metadataPath).replace(/\\/g, "/")}`);
