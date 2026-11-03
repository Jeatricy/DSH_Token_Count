import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
const manifest = JSON.parse(await readFile('package.json', 'utf8'));
const files = ['package.json', 'index.js', 'cordis.patch.yml', 'icon.svg', 'README.md', 'LICENSE', 'config.example.json', 'dist/client.js'];
for (const [directory, suffix] of [['src', '.js'], ['data', '.json'], ['docs', '.md']]) {
  for (const file of (await readdir(directory)).sort()) if (file.endsWith(suffix)) files.push(`${directory}/${file}`);
}
const blocks = [];
for (const file of files) {
  const body = await readFile(file);
  const header = Buffer.alloc(512);
  const put = (text, at, length) => header.write(text, at, length, 'utf8');
  const octal = (number, width) => number.toString(8).padStart(width - 1, '0') + '\0';
  const name = `package/${file}`;
  if (Buffer.byteLength(name) > 100) throw new Error(`Tar path too long: ${name}`);
  put(name, 0, 100); put(octal(0o644, 8), 100, 8); put(octal(0, 8), 108, 8); put(octal(0, 8), 116, 8);
  put(octal(body.length, 12), 124, 12); put(octal(0, 12), 136, 12);
  put('        ', 148, 8); put('0', 156, 1); put('ustar\0', 257, 6); put('00', 263, 2);
  put('root', 265, 32); put('root', 297, 32);
  const checksum = header.reduce((sum, value) => sum + value, 0);
  put(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  blocks.push(header, body, Buffer.alloc((512 - body.length % 512) % 512));
}
blocks.push(Buffer.alloc(1024));
const archive = gzipSync(Buffer.concat(blocks), { level: 9 });
await mkdir('dist', { recursive: true });
const filename = `${manifest.name}-${manifest.version}.tgz`;
await writeFile(`dist/${filename}`, archive);
const sha256 = createHash('sha256').update(archive).digest('hex');
await writeFile(`dist/${filename}.sha256`, `${sha256}  ${filename}\n`);
console.log(`${filename}: ${files.length} files, ${archive.length} bytes, SHA256 ${sha256}`);
