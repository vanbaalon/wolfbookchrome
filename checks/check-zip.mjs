// Verifies viewer/zip.js against a real zip built on the spot with the zip CLI.
// Node 18+ (has DecompressionStream/Blob/Response globals).
import { execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readZip } from '../viewer/zip.js';

const here = dirname(fileURLToPath(import.meta.url));
const work = mkdtempSync(join(tmpdir(), 'wbzip-'));
let failures = 0;
const check = (label, cond) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}`);
  if (!cond) failures++;
};

try {
  // Compressible text (deflate), an incompressible-ish binary, and a nested path.
  const big = 'Plot[Sin[x], {x, 0, 2 Pi}]\n'.repeat(500);
  writeFileSync(join(work, 'calculation.wb'), big);
  mkdirSync(join(work, 'img', 'calculation'), { recursive: true });
  const bytes = new Uint8Array(1024).map(() => Math.floor(Math.random() * 256));
  writeFileSync(join(work, 'img', 'calculation', 'wl_x.png'), bytes);
  execSync('zip -qr proj.zip calculation.wb img', { cwd: work });

  // Node Buffers are pooled: .buffer is bigger than the file and offset, so
  // slice out the exact bytes (browser fetch().arrayBuffer() is already exact).
  const buf = readFileSync(join(work, 'proj.zip'));
  const entries = await readZip(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));

  check('two file entries (dirs skipped)', entries.size === 2);
  check('deflated text round-trips', new TextDecoder().decode(entries.get('calculation.wb')) === big);
  const png = entries.get('img/calculation/wl_x.png');
  check('nested binary round-trips', png && png.length === 1024 && png.every((b, i) => b === bytes[i]));
} finally {
  rmSync(work, { recursive: true, force: true });
}
process.exit(failures ? 1 : 0);
