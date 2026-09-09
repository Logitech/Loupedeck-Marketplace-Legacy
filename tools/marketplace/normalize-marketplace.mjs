import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const REGISTRY_PATH = path.join(ROOT, "data", "marketplaces.json");

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

function canonicalInstallationLink(value) {
  return String(value || "").trim().replace(/\/+$/, "").toLowerCase();
}

function normalizeType(value) {
  const key = normalizeKey(value);

  if (!key) {
    return "unknown";
  }

  if (key.includes("plugin")) {
    return "plugin";
  }

  if (key.includes("profile")) {
    return "profile";
  }

  if (key.includes("iconlibrary")) {
    return "icon library";
  }

  if (key.includes("soundlibrary")) {
    return "sound library";
  }

  return String(value)
    .trim()
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function metadataValues(record, typeName) {
  return (record?.metadata || [])
    .filter((item) => normalizeKey(item.typeName) === normalizeKey(typeName))
    .map((item) => String(item.value || "").trim())
    .filter(Boolean);
}

function parseYamlScalar(yaml, key) {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = String(yaml || "").match(new RegExp(`^${escapedKey}:\\s*(.*)$`, "im"));

  if (!match) {
    return "";
  }

  return match[1]
    .trim()
    .replace(/^["']|["']$/g, "")
    .trim();
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
    const basename = decodeURIComponent(String(value).split(/[/?#]/)[0].split("/").pop() || "");
    return basename || null;
  }
}

function sanitizeReleaseFileName(value) {
  if (!value) {
    return null;
  }

  return value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_");
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

function buildIndex(records, keyFn) {
  const index = new Map();

  records.forEach((record, sourceIndex) => {
    const key = keyFn(record);
    if (!key) {
      return;
    }

    if (!index.has(key)) {
      index.set(key, []);
    }

    index.get(key).push({ record, sourceIndex });
  });

  return index;
}

function duplicateKeys(index) {
  return new Set([...index].filter(([, records]) => records.length > 1).map(([key]) => key));
}

function countByNormalizedPackageName(records) {
  const counts = new Map();

  for (const record of records) {
    const key = normalizeKey(record.packageName);
    if (!key) {
      continue;
    }

    counts.set(key, (counts.get(key) || 0) + 1);
  }

  return counts;
}

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== "") {
      return value;
    }
  }

  return "";
}

function buildManifestRecord({
  marketplace,
  catalogEntry,
  packageEntry,
  catalogIndex = null,
  packageIndex = null,
  matchMethod,
  packageNameDuplicates,
  duplicatedInstallationLinks,
}) {
  const catalog = catalogEntry || {};
  const publishedPackage = packageEntry || {};
  const packageName = firstDefined(catalog.packageName, publishedPackage.packageName);
  const catalogType = normalizeType(catalog.type);
  const packageType = normalizeType(publishedPackage.type);
  const normalizedType = catalogEntry ? catalogType : packageType;
  const sourceFileName = fileNameFromUrl(publishedPackage.installationFile);
  const releaseAssetFileName = sanitizeReleaseFileName(sourceFileName);
  const installationLink = firstDefined(catalog.installationLink, publishedPackage.installationLink);
  const installationLinkKey = canonicalInstallationLink(installationLink);
  const yamlDisplayName = parseYamlScalar(publishedPackage.yaml, "displayName");
  const yamlAuthor = parseYamlScalar(publishedPackage.yaml, "author");
  const reviewFlags = [];

  if (!catalogEntry) {
    reviewFlags.push("missing-catalog-record");
  }

  if (!packageEntry) {
    reviewFlags.push("missing-package-record");
  }

  if (packageEntry && !publishedPackage.installationFile) {
    reviewFlags.push("missing-installation-file");
  }

  if (catalogEntry && packageEntry && catalog.type && publishedPackage.type && catalogType !== packageType) {
    reviewFlags.push("type-mismatch");
  }

  if (
    catalogEntry &&
    packageEntry &&
    String(catalog.version || "").trim() &&
    String(publishedPackage.version || "").trim() &&
    String(catalog.version || "").trim() !== String(publishedPackage.version || "").trim()
  ) {
    reviewFlags.push("version-mismatch");
  }

  if (packageNameDuplicates.has(normalizeKey(packageName))) {
    reviewFlags.push("duplicate-package-name");
  }

  if (installationLinkKey && duplicatedInstallationLinks.has(installationLinkKey)) {
    reviewFlags.push("duplicate-installation-link");
  }

  if (
    catalogEntry &&
    packageEntry &&
    canonicalInstallationLink(catalog.installationLink) &&
    canonicalInstallationLink(publishedPackage.installationLink) &&
    canonicalInstallationLink(catalog.installationLink) !== canonicalInstallationLink(publishedPackage.installationLink)
  ) {
    reviewFlags.push("installation-link-mismatch");
  }

  return {
    marketplaceId: marketplace.id,
    packageName,
    displayName: firstDefined(catalog.displayName, yamlDisplayName, packageName),
    type: normalizedType,
    version: firstDefined(catalog.version, publishedPackage.version),
    author: firstDefined(catalog.author, yamlAuthor),
    categories: metadataValues(catalog, "category"),
    platforms: metadataValues(catalog, "operatingsystem"),
    devices: metadataValues(catalog, "device"),
    languages: metadataValues(catalog, "language"),
    shortDescription: firstDefined(catalog.shortDescription),
    description: firstDefined(catalog.description),
    iconUrl: firstDefined(catalog.icon, publishedPackage.icon),
    coverImageUrl: firstDefined(catalog.coverImage) || null,
    supportUrl: firstDefined(catalog.supportUrl) || null,
    homepageUrl: firstDefined(catalog.homepageUrl) || null,
    licenseUrl: firstDefined(catalog.licenseUrl) || null,
    published: firstDefined(catalog.published, publishedPackage.published) || null,
    minimumLoupedeckVersion: firstDefined(catalog.minimumLoupedeckVersion) || null,
    downloadCount: catalog.downloadCount ?? null,
    installationLink: installationLink || null,
    sourceInstallationFile: publishedPackage.installationFile || null,
    releaseAssetFileName,
    releaseDownloadUrl: releaseDownloadUrl(marketplace, releaseAssetFileName),
    sizeBytes: null,
    sha256: firstDefined(catalog.installationFileHash) || null,
    sources: [
      ...(catalogEntry ? [marketplace.sources.catalog.id || `${marketplace.id}-catalog`] : []),
      ...(packageEntry ? [marketplace.sources.packages.id || `${marketplace.id}-package-api`] : []),
    ],
    sourceTypes: {
      catalog: catalogEntry ? catalog.type || null : null,
      package: packageEntry ? publishedPackage.type || null : null,
    },
    sourceIndexes: {
      catalog: catalogIndex,
      package: packageIndex,
    },
    matchMethod,
    reviewFlags,
  };
}

async function readJson(filePath, label) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Could not read ${label} at ${path.relative(ROOT, filePath)}: ${error.message}`);
  }
}

const marketplaceId = process.argv[2] || "v59";
const registry = await readJson(REGISTRY_PATH, "marketplace registry");
const marketplace = resolveMarketplace(registry, marketplaceId);
const sourceDir = path.join(ROOT, marketplace.workingSourceDir || "working/source");
const outputDir = path.join(ROOT, marketplace.dataDir || path.join("data", marketplaceId));
const catalogPath = path.join(sourceDir, marketplace.sources.catalog.fileName);
const packagesPath = path.join(sourceDir, marketplace.sources.packages.fileName);
const metadataPath = path.join(sourceDir, `${marketplaceId}-source-metadata.json`);

const catalogRecords = await readJson(catalogPath, "catalog source");
const packageRecords = await readJson(packagesPath, "package source");
let sourceMetadata = null;
try {
  sourceMetadata = await readJson(metadataPath, "source metadata");
} catch {
  sourceMetadata = null;
}

if (!Array.isArray(catalogRecords) || !Array.isArray(packageRecords)) {
  throw new Error("Catalog and package source files must both contain JSON arrays");
}

const catalogByLink = buildIndex(catalogRecords, (record) => canonicalInstallationLink(record.installationLink));
const packageByLink = buildIndex(packageRecords, (record) => canonicalInstallationLink(record.installationLink));
const packageByName = buildIndex(packageRecords, (record) => normalizeKey(record.packageName));
const catalogPackageNameCounts = countByNormalizedPackageName(catalogRecords);
const publishedPackageNameCounts = countByNormalizedPackageName(packageRecords);
const duplicatedPackageNames = new Set(
  [...new Set([...catalogPackageNameCounts.keys(), ...publishedPackageNameCounts.keys()])].filter(
    (key) => (catalogPackageNameCounts.get(key) || 0) > 1 || (publishedPackageNameCounts.get(key) || 0) > 1,
  ),
);
const duplicatedInstallationLinks = new Set([
  ...duplicateKeys(catalogByLink),
  ...duplicateKeys(packageByLink),
]);
const usedPackageIndexes = new Set();
const records = [];

catalogRecords.forEach((catalogEntry, catalogIndex) => {
  const installationLinkKey = canonicalInstallationLink(catalogEntry.installationLink);
  const packageNameKey = normalizeKey(catalogEntry.packageName);
  const linkMatches = installationLinkKey ? packageByLink.get(installationLinkKey) || [] : [];
  let packageMatch = null;
  let matchMethod = "none";

  if (linkMatches.length === 1 && !usedPackageIndexes.has(linkMatches[0].sourceIndex)) {
    packageMatch = linkMatches[0];
    matchMethod = "installationLink";
  } else if (packageNameKey) {
    const nameMatches = (packageByName.get(packageNameKey) || []).filter(
      (candidate) => !usedPackageIndexes.has(candidate.sourceIndex),
    );

    if (nameMatches.length === 1) {
      packageMatch = nameMatches[0];
      matchMethod = linkMatches.length > 1 ? "packageName-after-duplicate-link" : "packageName";
    }
  }

  if (packageMatch) {
    usedPackageIndexes.add(packageMatch.sourceIndex);
  }

  records.push(
    buildManifestRecord({
      marketplace,
      catalogEntry,
      packageEntry: packageMatch?.record,
      catalogIndex,
      packageIndex: packageMatch?.sourceIndex ?? null,
      matchMethod,
      packageNameDuplicates: duplicatedPackageNames,
      duplicatedInstallationLinks,
    }),
  );
});

packageRecords.forEach((packageEntry, packageIndex) => {
  if (usedPackageIndexes.has(packageIndex)) {
    return;
  }

  records.push(
    buildManifestRecord({
      marketplace,
      catalogEntry: null,
      packageEntry,
      packageIndex,
      matchMethod: "unmatched-package",
      packageNameDuplicates: duplicatedPackageNames,
      duplicatedInstallationLinks,
    }),
  );
});

const fileNameCounts = new Map();
for (const record of records) {
  if (!record.releaseAssetFileName) {
    continue;
  }

  const key = record.releaseAssetFileName.toLowerCase();
  fileNameCounts.set(key, (fileNameCounts.get(key) || 0) + 1);
}

for (const record of records) {
  if (record.releaseAssetFileName && fileNameCounts.get(record.releaseAssetFileName.toLowerCase()) > 1) {
    record.reviewFlags.push("duplicate-output-filename");
  }

  record.reviewFlags = [...new Set(record.reviewFlags)].sort();
}

records.sort((a, b) => {
  const typeCompare = a.type.localeCompare(b.type);
  if (typeCompare !== 0) {
    return typeCompare;
  }

  return a.displayName.localeCompare(b.displayName);
});

const manifest = {
  schemaVersion: 1,
  marketplaceId,
  title: marketplace.title,
  softwareRange: marketplace.softwareRange,
  releaseTag: marketplace.releaseTag,
  generatedAt: new Date().toISOString(),
  sourceMetadata,
  counts: {
    catalogRecords: catalogRecords.length,
    packageRecords: packageRecords.length,
    manifestRecords: records.length,
    recordsWithCatalog: records.filter((record) => record.sources.includes(marketplace.sources.catalog.id)).length,
    recordsWithPackage: records.filter((record) => record.sources.includes(marketplace.sources.packages.id)).length,
    recordsWithInstallationFile: records.filter((record) => record.sourceInstallationFile).length,
  },
  assets: records,
};

await fs.mkdir(outputDir, { recursive: true });
const manifestPath = path.join(outputDir, "manifest.json");
await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`Wrote ${records.length} manifest records to ${path.relative(ROOT, manifestPath).replace(/\\/g, "/")}`);
console.log(`${manifest.counts.recordsWithInstallationFile} records have source installation files`);
