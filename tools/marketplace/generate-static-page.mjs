#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const TYPE_ORDER = ['plugin', 'profile', 'icon-library'];
const TYPE_LABELS = {
  plugin: 'Plugin',
  profile: 'Profile',
  'icon-library': 'Icon Library',
};
const TYPE_ALIASES = new Map([
  ['1', 'profile'],
  ['profile', 'profile'],
  ['profiles', 'profile'],
  ['2', 'plugin'],
  ['plugin', 'plugin'],
  ['plugins', 'plugin'],
  ['4', 'icon-library'],
  ['icon library', 'icon-library'],
  ['icon-library', 'icon-library'],
  ['icon_library', 'icon-library'],
  ['icons', 'icon-library'],
  ['icon pack', 'icon-library'],
  ['icon-pack', 'icon-library'],
]);
const BLOCKING_FLAGS = new Set([
  'missing-catalog-record',
  'missing-package-record',
  'missing-installation-file',
  'duplicate-output-filename',
]);

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const rootDir = process.cwd();
  const marketplaceId = options.id ?? 'v59';
  const registryPath = resolveFromRoot(rootDir, options.registry ?? 'data/marketplaces.json');
  const manifestPath = resolveFromRoot(rootDir, options.manifest ?? `data/${marketplaceId}/manifest.json`);

  const registry = await readJson(registryPath, `Marketplace registry not found: ${registryPath}`);
  const marketplace = findMarketplace(registry, marketplaceId);
  if (!marketplace) {
    throw new Error(`Marketplace "${marketplaceId}" was not found in ${registryPath}.`);
  }

  const manifestJson = await readJson(manifestPath, `Marketplace manifest not found: ${manifestPath}`);
  const records = getManifestRecords(manifestJson);
  const normalized = records.map((record, index) => normalizeRecord(record, index, marketplace));
  const candidates = normalized.filter((record) => record.marketplaceId === marketplaceId || !record.marketplaceId);
  const publishable = candidates
    .filter((record) => record.displayName)
    .filter((record) => record.downloadUrl)
    .filter((record) => !record.hasBlockingReviewFlags)
    .sort(compareRecords);

  const hiddenCount = candidates.length - publishable.length;
  const outputPath = resolveFromRoot(
    rootDir,
    options.output ?? marketplace.outputPath ?? `marketplaces/${marketplaceId}/index.html`,
  );
  const generatedAt = new Date().toISOString();
  const html = renderPage({ marketplace, marketplaceId, records: publishable, hiddenCount, generatedAt });

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, html, 'utf8');

  console.log(`Generated ${path.relative(rootDir, outputPath)} from ${publishable.length} public records.`);
  if (hiddenCount > 0) {
    console.log(`Hidden ${hiddenCount} records because they lacked display data, lacked a download URL, or had blocking review flags.`);
  }
}

function parseArgs(args) {
  const options = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--registry') {
      options.registry = requireValue(args, (index += 1), arg);
    } else if (arg === '--manifest') {
      options.manifest = requireValue(args, (index += 1), arg);
    } else if (arg === '--output') {
      options.output = requireValue(args, (index += 1), arg);
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown option: ${arg}`);
    } else if (!options.id) {
      options.id = arg;
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }

  return options;
}

function requireValue(args, index, optionName) {
  const value = args[index];
  if (!value || value.startsWith('--')) {
    throw new Error(`${optionName} requires a value.`);
  }
  return value;
}

function printHelp() {
  console.log(`Usage: node tools/marketplace/generate-static-page.mjs [marketplace-id] [options]

Options:
  --registry <path>  Registry JSON path. Defaults to data/marketplaces.json.
  --manifest <path>  Manifest JSON path. Defaults to data/<marketplace-id>/manifest.json.
  --output <path>    Output HTML path. Defaults to the registry outputPath.
  --help             Show this help.
`);
}

function resolveFromRoot(rootDir, filePath) {
  return path.isAbsolute(filePath) ? filePath : path.join(rootDir, filePath);
}

async function readJson(filePath, missingMessage) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(missingMessage);
    }
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON in ${filePath}: ${error.message}`);
    }
    throw error;
  }
}

function findMarketplace(registry, marketplaceId) {
  const marketplaces = Array.isArray(registry)
    ? registry
    : registry.marketplaces ?? registry.items ?? Object.values(registry);

  if (!Array.isArray(marketplaces)) {
    throw new Error('Marketplace registry must be an array or an object with a marketplaces array.');
  }

  return marketplaces.find((marketplace) => marketplace?.id === marketplaceId);
}

function getManifestRecords(manifestJson) {
  if (Array.isArray(manifestJson)) {
    return manifestJson;
  }

  const records = manifestJson.records ?? manifestJson.assets ?? manifestJson.packages ?? manifestJson.items;
  if (!Array.isArray(records)) {
    throw new Error('Marketplace manifest must be an array or an object with records/assets/packages/items.');
  }

  return records;
}

function normalizeRecord(record, index, marketplace) {
  const type = normalizeType(firstValue(record.type, record.assetType, record.packageType, record.kind));
  const downloadUrl = selectDownloadUrl(record, marketplace);

  return {
    raw: record,
    index,
    marketplaceId: stringOrEmpty(record.marketplaceId),
    packageName: stringOrEmpty(firstValue(record.packageName, record.name, record.id)),
    displayName: stringOrEmpty(firstValue(record.displayName, record.title, record.packageName, record.name, record.id)),
    type,
    typeLabel: TYPE_LABELS[type] ?? titleCase(type),
    version: stringOrEmpty(firstValue(record.version, record.packageVersion)),
    author: stringOrEmpty(firstValue(record.author, record.publisher, record.vendor, record.developer)),
    categories: arrayOfStrings(firstValue(record.categories, record.category)),
    platforms: arrayOfStrings(firstValue(record.platforms, record.operatingSystems, record.supportedOperatingSystems, record.os)),
    devices: arrayOfStrings(firstValue(record.devices, record.supportedDevices, record.deviceCompatibility)),
    shortDescription: stringOrEmpty(firstValue(record.shortDescription, record.summary, record.teaser, record.description)),
    description: stringOrEmpty(firstValue(record.description, record.fullDescription, record.longDescription)),
    iconUrl: stringOrEmpty(firstValue(record.iconUrl, record.icon, record.thumbnailUrl, record.imageUrl)),
    downloadUrl: stringOrEmpty(downloadUrl),
    releaseAssetFileName: stringOrEmpty(record.releaseAssetFileName),
    sizeBytes: numberOrNull(record.sizeBytes),
    sha256: stringOrEmpty(record.sha256),
    reviewFlags: normalizeReviewFlags(record.reviewFlags ?? record.flags),
    hasBlockingReviewFlags: hasBlockingReviewFlags(record.reviewFlags ?? record.flags),
  };
}

function selectDownloadUrl(record, marketplace) {
  const sourceUrl = firstValue(record.downloadUrl, record.sourceInstallationFile, record.installationFile, record.sourceDownloadUrl);
  const releaseUrl = record.releaseDownloadUrl;

  if (marketplace.downloadMode === 'release') {
    return firstValue(releaseUrl, sourceUrl);
  }

  return firstValue(sourceUrl, releaseUrl);
}

function firstValue(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '');
}

function stringOrEmpty(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function arrayOfStrings(value) {
  if (Array.isArray(value)) {
    return value.map(stringOrEmpty).filter(Boolean);
  }
  if (typeof value === 'string' && value.includes(',')) {
    return value.split(',').map(stringOrEmpty).filter(Boolean);
  }
  return stringOrEmpty(value) ? [stringOrEmpty(value)] : [];
}

function normalizeType(value) {
  const normalized = stringOrEmpty(value).toLowerCase().replace(/\s+/g, ' ').trim();
  const slug = normalized.replace(/[\s_]+/g, '-');
  return (TYPE_ALIASES.get(normalized) ?? slug) || 'unknown';
}

function normalizeReviewFlags(flags) {
  if (!Array.isArray(flags)) {
    return flags ? [String(flags)] : [];
  }
  return flags.map((flag) => {
    if (typeof flag === 'string') {
      return flag;
    }
    return firstValue(flag.code, flag.name, flag.flag, flag.message, JSON.stringify(flag));
  }).map(stringOrEmpty).filter(Boolean);
}

function hasBlockingReviewFlags(flags) {
  if (!Array.isArray(flags)) {
    return BLOCKING_FLAGS.has(stringOrEmpty(flags));
  }

  return flags.some((flag) => {
    if (typeof flag === 'string') {
      return BLOCKING_FLAGS.has(flag.trim().toLowerCase());
    }

    if (flag?.blocking === false || flag?.publish === true) {
      return false;
    }
    if (flag?.blocking === true) {
      return true;
    }

    return BLOCKING_FLAGS.has(stringOrEmpty(firstValue(flag?.code, flag?.name, flag?.flag)).toLowerCase());
  });
}

function compareRecords(left, right) {
  const typeDiff = typeRank(left.type) - typeRank(right.type);
  if (typeDiff !== 0) {
    return typeDiff;
  }
  return left.displayName.localeCompare(right.displayName, undefined, { sensitivity: 'base' });
}

function typeRank(type) {
  const index = TYPE_ORDER.indexOf(type);
  return index === -1 ? TYPE_ORDER.length : index;
}

function renderPage({ marketplace, marketplaceId, records, hiddenCount, generatedAt }) {
  const title = marketplace.title ?? `Loupedeck Marketplace ${marketplaceId}`;
  const softwareRange = marketplace.softwareRange ? ` for software ${marketplace.softwareRange}` : '';
  const sections = groupByType(records);
  const filterButtons = renderFilterButtons(sections);
  const sectionHtml = [...sections.entries()].map(([type, typeRecords]) => renderSection(type, typeRecords)).join('\n\n');
  const hiddenNote = hiddenCount > 0
    ? `<span>${hiddenCount} record${hiddenCount === 1 ? '' : 's'} hidden pending review, display data, or download archival.</span>`
    : '<span>All manifest records with downloads passed public-page checks.</span>';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(title)}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: Arial, sans-serif;
      background: #18161B;
      color: #F0F0F0;
      min-height: 100vh;
    }
    header {
      background: #29282A;
      border-bottom: 1px solid #4A484B;
      padding: 24px 32px;
    }
    header h1 { font-size: 1.6rem; color: #F0F0F0; }
    header p { color: #9E9CA0; margin-top: 6px; font-size: 0.9rem; line-height: 1.5; }
    header a { color: #BEA1FE; }
    .toolbar {
      padding: 20px 32px;
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
      align-items: center;
    }
    .toolbar input {
      background: #383739;
      border: 2px solid #4A484B;
      color: #F0F0F0;
      padding: 8px 14px;
      border-radius: 4px;
      font-size: 0.9rem;
      width: min(100%, 280px);
    }
    .toolbar input:focus { outline: none; border-color: #BEA1FE; }
    .filter-btn {
      background: #333234;
      border: 1px solid #4A484B;
      color: #9E9CA0;
      padding: 7px 14px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 0.85rem;
      min-height: 34px;
    }
    .filter-btn:focus-visible { outline: 2px solid #BEA1FE; outline-offset: 2px; }
    .filter-btn.active { background: #7F32BA; border-color: #7F32BA; color: #F0F0F0; }
    .count { color: #848287; font-size: 0.85rem; margin-left: auto; }
    .section { padding: 0 32px 32px; }
    .section-title {
      font-size: 0.78rem;
      text-transform: uppercase;
      letter-spacing: 0;
      color: #848287;
      margin-bottom: 16px;
      padding-top: 24px;
      border-top: 1px solid #333234;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(min(320px, 100%), 1fr));
      gap: 16px;
    }
    .card {
      background: #333234;
      border: 1px solid #4A484B;
      border-radius: 8px;
      padding: 20px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      min-width: 0;
    }
    .card-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
    .title-wrap { min-width: 0; }
    .card-title { font-size: 1rem; font-weight: 600; color: #F0F0F0; overflow-wrap: anywhere; }
    .card-author { font-size: 0.8rem; color: #848287; margin-top: 3px; overflow-wrap: anywhere; }
    .icon {
      width: 44px;
      height: 44px;
      border-radius: 8px;
      object-fit: cover;
      background: #29282A;
      border: 1px solid #4A484B;
      flex: 0 0 auto;
    }
    .badges { display: flex; gap: 6px; flex-wrap: wrap; }
    .badge {
      font-size: 0.7rem;
      padding: 2px 8px;
      border-radius: 20px;
      font-weight: 500;
      overflow-wrap: anywhere;
    }
    .badge-win { background: #1a3a5c; color: #60a5fa; }
    .badge-mac { background: #1a3a2e; color: #4ade80; }
    .badge-type { background: #40195D; color: #BEA1FE; }
    .badge-ver { background: #29282A; color: #9E9CA0; }
    .badge-device { background: #1a2e1a; color: #6ee7b7; }
    .badge-category { background: #4A3218; color: #f5c16c; }
    .short-desc { font-size: 0.85rem; color: #9E9CA0; line-height: 1.5; overflow-wrap: anywhere; }
    .desc-toggle {
      font-size: 0.8rem;
      color: #BEA1FE;
      cursor: pointer;
      background: none;
      border: none;
      padding: 0;
      text-align: left;
      width: fit-content;
    }
    .desc-toggle:hover { text-decoration: underline; }
    .desc-toggle:focus-visible { outline: 2px solid #BEA1FE; outline-offset: 2px; }
    .full-desc {
      display: none;
      font-size: 0.82rem;
      color: #F0F0F0;
      line-height: 1.65;
      border-top: 1px solid #4A484B;
      padding-top: 12px;
      max-height: 320px;
      overflow-y: auto;
      overflow-wrap: anywhere;
    }
    .full-desc.open { display: block; }
    .full-desc p { margin-bottom: 8px; }
    .full-desc ul, .full-desc ol { padding-left: 18px; margin-bottom: 8px; }
    .full-desc li { margin-bottom: 4px; }
    .full-desc code { background: #18161B; padding: 1px 5px; border-radius: 3px; font-size: 0.8rem; }
    .full-desc a { color: #BEA1FE; text-decoration: underline; }
    .card-footer { margin-top: auto; display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
    .dl-btn {
      background: #7F32BA;
      color: #F0F0F0;
      border: none;
      padding: 8px 16px;
      border-radius: 4px;
      font-size: 0.85rem;
      font-weight: 500;
      cursor: pointer;
      text-decoration: none;
      display: inline-block;
    }
    .dl-btn:hover { background: #40195D; }
    .dl-btn:focus-visible { outline: 2px solid #BEA1FE; outline-offset: 2px; }
    .file-meta { font-size: 0.78rem; color: #848287; }
    .empty-state {
      display: none;
      margin: 0 32px 32px;
      padding: 20px;
      border: 1px solid #4A484B;
      border-radius: 8px;
      background: #29282A;
      color: #9E9CA0;
      font-size: 0.9rem;
    }
    .hidden { display: none !important; }
    footer {
      display: flex;
      gap: 10px;
      justify-content: center;
      flex-wrap: wrap;
      text-align: center;
      padding: 32px;
      color: #666468;
      font-size: 0.8rem;
      border-top: 1px solid #4A484B;
    }
    footer a { color: #BEA1FE; text-decoration: underline; }
    footer a:hover { color: #974ED0; }
    @media (max-width: 640px) {
      header, .toolbar, .section { padding-left: 20px; padding-right: 20px; }
      .count { width: 100%; margin-left: 0; }
      .empty-state { margin-left: 20px; margin-right: 20px; }
    }
  </style>
</head>
<body>
<header>
  <h1>${escapeHtml(title)}</h1>
  <p>Static archive of v5.9 marketplace packages${escapeHtml(softwareRange)}. Downloads are served from reviewed manifest links and do not require a Loupedeck account.</p>
</header>

<div class="toolbar">
  <input type="search" id="search" placeholder="Search packages..." oninput="filterCards()" />
${filterButtons}
  <span class="count" id="count"></span>
</div>

<div id="content">
${sectionHtml || renderEmptyContent()}
</div>
<div class="empty-state" id="empty-state">No packages match the current search and filter.</div>

<footer>
  <span>Generated ${escapeHtml(generatedAt)}.</span>
  <span>${records.length} public package${records.length === 1 ? '' : 's'}.</span>
  ${hiddenNote}
  <span><a href="notice.html">Marketplace notice</a></span>
</footer>

<script>
const cards = document.querySelectorAll('.card');
let activeType = 'all';

function filterCards() {
  const q = document.getElementById('search').value.toLowerCase();
  let visible = 0;
  cards.forEach((card) => {
    const matchType = activeType === 'all' || card.dataset.type === activeType;
    const matchText = !q || card.dataset.search.includes(q);
    const show = matchType && matchText;
    card.classList.toggle('hidden', !show);
    if (show) visible += 1;
  });

  document.querySelectorAll('.section').forEach((section) => {
    const anyVisible = [...section.querySelectorAll('.card')].some((card) => !card.classList.contains('hidden'));
    section.classList.toggle('hidden', !anyVisible);
  });

  document.getElementById('count').textContent = visible + ' package' + (visible === 1 ? '' : 's');
  document.getElementById('empty-state').style.display = visible === 0 ? 'block' : 'none';
}

function setFilter(type, button) {
  activeType = type;
  document.querySelectorAll('.filter-btn').forEach((candidate) => candidate.classList.remove('active'));
  button.classList.add('active');
  filterCards();
}

function toggleDesc(id) {
  const element = document.getElementById(id);
  const button = element.previousElementSibling;
  element.classList.toggle('open');
  button.textContent = element.classList.contains('open') ? 'Hide description' : 'Show description';
}

filterCards();
</script>
</body>
</html>
`;
}

function groupByType(records) {
  const sections = new Map();
  for (const type of TYPE_ORDER) {
    const typeRecords = records.filter((record) => record.type === type);
    if (typeRecords.length > 0) {
      sections.set(type, typeRecords);
    }
  }

  for (const record of records) {
    if (!sections.has(record.type)) {
      sections.set(record.type, []);
    }
    if (!TYPE_ORDER.includes(record.type)) {
      sections.get(record.type).push(record);
    }
  }

  return sections;
}

function renderFilterButtons(sections) {
  const buttons = ['  <button class="filter-btn active" data-type="all" onclick="setFilter(\'all\', this)">All</button>'];
  for (const [type, records] of sections.entries()) {
    buttons.push(`  <button class="filter-btn" data-type="${escapeAttr(type)}" onclick="setFilter('${escapeJsString(type)}', this)">${escapeHtml(TYPE_LABELS[type] ?? titleCase(type))} (${records.length})</button>`);
  }
  return buttons.join('\n');
}

function renderSection(type, records) {
  return `  <div class="section" data-section-type="${escapeAttr(type)}">
    <div class="section-title">${escapeHtml(TYPE_LABELS[type] ?? titleCase(type))} (${records.length})</div>
    <div class="grid">
${records.map(renderCard).join('\n')}
    </div>
  </div>`;
}

function renderCard(record) {
  const descId = `desc-${record.index}`;
  const description = renderDescription(record.description);
  const badges = renderBadges(record);
  const icon = record.iconUrl
    ? `<img class="icon" src="${escapeAttr(record.iconUrl)}" alt="" loading="lazy" />`
    : '';
  const meta = renderFileMeta(record);

  return `      <article class="card" data-type="${escapeAttr(record.type)}" data-search="${escapeAttr(searchText(record))}">
        <div class="card-header">
          <div class="title-wrap">
            <div class="card-title">${escapeHtml(record.displayName)}</div>
            ${record.author ? `<div class="card-author">${escapeHtml(record.author)}</div>` : ''}
          </div>
          ${icon}
        </div>
        ${badges}
        ${record.shortDescription ? `<div class="short-desc">${escapeHtml(record.shortDescription)}</div>` : ''}
        ${description ? `<button class="desc-toggle" onclick="toggleDesc('${descId}')">Show description</button>
        <div class="full-desc" id="${descId}">${description}</div>` : ''}
        <div class="card-footer">
          <a class="dl-btn" href="${escapeAttr(record.downloadUrl)}" download>Download</a>
          ${meta}
        </div>
      </article>`;
}

function renderBadges(record) {
  const badges = [
    `<span class="badge badge-type">${escapeHtml(record.typeLabel)}</span>`,
    record.version ? `<span class="badge badge-ver">v${escapeHtml(stripVersionPrefix(record.version))}</span>` : '',
    ...record.platforms.map((platform) => renderPlatformBadge(platform)),
    ...record.devices.map((device) => `<span class="badge badge-device">${escapeHtml(device)}</span>`),
    ...record.categories.map((category) => `<span class="badge badge-category">${escapeHtml(category)}</span>`),
  ].filter(Boolean);

  return badges.length > 0 ? `<div class="badges">${badges.join(' ')}</div>` : '';
}

function renderPlatformBadge(platform) {
  const normalized = platform.toLowerCase();
  const className = normalized.includes('win') ? 'badge-win' : normalized.includes('mac') ? 'badge-mac' : 'badge-device';
  return `<span class="badge ${className}">${escapeHtml(platform)}</span>`;
}

function renderFileMeta(record) {
  const parts = [
    record.releaseAssetFileName,
    record.sizeBytes ? formatBytes(record.sizeBytes) : '',
    record.sha256 ? `SHA-256 ${record.sha256.slice(0, 12)}` : '',
  ].filter(Boolean);

  return parts.length > 0 ? `<span class="file-meta">${escapeHtml(parts.join(' | '))}</span>` : '';
}

function renderDescription(text) {
  const trimmed = stringOrEmpty(text);
  if (!trimmed) {
    return '';
  }

  const blocks = trimmed.replace(/\r\n/g, '\n').split(/\n{2,}/);
  return blocks.map((block) => {
    const lines = block.split('\n').map((line) => line.trim()).filter(Boolean);
    if (lines.length > 0 && lines.every((line) => /^[-*]\s+/.test(line))) {
      return `<ul>${lines.map((line) => `<li>${renderInlineMarkdown(line.replace(/^[-*]\s+/, ''))}</li>`).join('')}</ul>`;
    }
    if (lines.length > 0 && lines.every((line) => /^\d+\.\s+/.test(line))) {
      return `<ol>${lines.map((line) => `<li>${renderInlineMarkdown(line.replace(/^\d+\.\s+/, ''))}</li>`).join('')}</ol>`;
    }
    return `<p>${lines.map(renderInlineMarkdown).join('<br>')}</p>`;
  }).join('');
}

function renderInlineMarkdown(text) {
  const escaped = escapeHtml(text);
  return escaped
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
}

function renderEmptyContent() {
  return `  <div class="section">
    <div class="section-title">Packages (0)</div>
    <div class="grid"></div>
  </div>`;
}

function searchText(record) {
  return [
    record.displayName,
    record.packageName,
    record.author,
    record.typeLabel,
    record.version,
    ...record.categories,
    ...record.platforms,
    ...record.devices,
    record.shortDescription,
    record.description,
  ].join(' ').toLowerCase();
}

function stripVersionPrefix(version) {
  return version.replace(/^v/i, '');
}

function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const precision = unitIndex === 0 || value >= 10 ? 0 : 1;
  return `${value.toFixed(precision)} ${units[unitIndex]}`;
}

function titleCase(value) {
  return stringOrEmpty(value)
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function escapeHtml(value) {
  return stringOrEmpty(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/[\r\n]+/g, ' ');
}

function escapeJsString(value) {
  return stringOrEmpty(value)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n');
}
