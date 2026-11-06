// Download copies for an optional GitHub Release; never uploads or runs installers.
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../../', import.meta.url));
const manifest = JSON.parse(await readFile(new URL('./installers.json', import.meta.url), 'utf8'));
const output = path.join(root, 'working', 'website-installers');
await mkdir(output, { recursive: true });
const records = [];
for (const installer of manifest.installers) {
  const destination = path.join(output, installer.filename);
  const existing = await stat(destination).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (!existing) {
    console.log(`Downloading ${installer.filename}...`);
    const response = await fetch(installer.url, { signal: AbortSignal.timeout(600000) });
    if (!response.ok || !response.body) throw new Error(`Download failed: ${response.status} ${installer.url}`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(`${destination}.partial`, { flags: 'w' }));
    const downloaded = await stat(`${destination}.partial`);
    if (downloaded.size !== installer.bytes) throw new Error(`Unexpected size for ${installer.filename}: ${downloaded.size}`);
    await rename(`${destination}.partial`, destination);
  }
  const size = (await stat(destination)).size;
  if (size !== installer.bytes) throw new Error(`Unexpected size for existing ${installer.filename}: ${size}`);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(destination)) hash.update(chunk);
  const sha256 = hash.digest('hex');
  if (installer.sha256 && sha256 !== installer.sha256) throw new Error(`Checksum mismatch: ${installer.filename}`);
  records.push({ ...installer, sha256 });
  console.log(`Verified ${installer.filename}: ${sha256}`);
}
await writeFile(path.join(output, 'archive-record.json'), JSON.stringify({ recordedAt: new Date().toISOString(), installers: records }, null, 2) + '\n');
await writeFile(path.join(output, 'SHA256SUMS.txt'), records.map(record => `${record.sha256}  ${record.filename}`).join('\n') + '\n');
console.log(`Archive prepared in ${output}. No files have been published.`);
