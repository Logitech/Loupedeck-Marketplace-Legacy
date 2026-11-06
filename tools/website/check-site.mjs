// No dependencies. Checks local paths/anchors and, optionally, public links.
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../website/', import.meta.url));
const base = new URL('https://local.invalid/');
const files = [];
async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(filename);
    else if (/\.(html|css)$/.test(entry.name)) files.push(filename);
  }
}
await walk(root);
const errors = [];
const external = new Map();
let checked = 0;
for (const file of files) {
  const source = await readFile(file, 'utf8');
  const relative = path.relative(root, file).replaceAll('\\', '/');
  const references = relative.endsWith('.css')
    ? [...source.matchAll(/url\(["']?([^"')]+)["']?\)/g)].map(match => match[1])
    : [...source.matchAll(/(?:href|src)="([^"]+)"/g)].map(match => match[1].replaceAll('&amp;', '&'));
  for (const reference of references) {
    checked++;
    const url = new URL(reference, new URL(relative, base));
    if (url.origin !== base.origin) {
      if (url.protocol !== 'https:') errors.push(`${relative}: expected HTTPS: ${reference}`);
      else external.set(url.href, url);
      continue;
    }
    let target = path.join(root, decodeURIComponent(url.pathname));
    if (url.pathname.endsWith('/')) target = path.join(target, 'index.html');
    try {
      if (!(await stat(target)).isFile()) throw new Error('not a file');
      if (url.hash) {
        const content = await readFile(target, 'utf8');
        if (!content.includes(`id="${decodeURIComponent(url.hash.slice(1))}"`)) errors.push(`${relative}: missing anchor ${reference}`);
      }
    } catch {
      errors.push(`${relative}: missing file ${reference}`);
    }
  }
}
const manifest = JSON.parse(await readFile(new URL('./installers.json', import.meta.url), 'utf8'));
const downloadHtml = await readFile(path.join(root, 'downloads', 'index.html'), 'utf8');
for (const installer of manifest.installers) {
  if (!downloadHtml.includes(`href="${installer.url}"`)) errors.push(`Missing installer link: ${installer.filename}`);
}
if (process.argv.includes('--online')) {
  // Bound concurrency to avoid sending a burst of requests to the support host.
  const queue = [...external.values()];
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (queue.length) {
      const url = queue.shift();
      try {
        const response = await fetch(url, { method: url.hash ? 'GET' : 'HEAD', signal: AbortSignal.timeout(30000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        if (url.hash) {
          const html = await response.text();
          if (!html.includes(`id="${decodeURIComponent(url.hash.slice(1))}"`)) throw new Error(`Missing anchor ${url.hash}`);
        }
        const installer = manifest.installers.find(item => item.url === url.href);
        if (installer && Number(response.headers.get('content-length')) !== installer.bytes) throw new Error('Installer size changed');
        console.log(`OK ${url.href}`);
      } catch (error) {
        errors.push(`${url.href}: ${error.message}`);
      }
    }
  }));
}
if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Checked ${files.length} HTML/CSS files and ${checked} references${process.argv.includes('--online') ? `, including ${external.size} public links` : ''}. All passed.`);
}
