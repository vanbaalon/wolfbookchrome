// zip.js — minimal ZIP reader, zero dependencies.
// Handles stored (0) and deflated (8) entries via the browser-native
// DecompressionStream('deflate-raw') (Chrome 103+). Enough for Overleaf's
// /project/<id>/download/zip; not a general-purpose zip library (no zip64,
// no encryption, no spanned archives).

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

async function inflateRaw(bytes) {
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * @param {ArrayBuffer} buf
 * @returns {Promise<Map<string, Uint8Array>>} path → bytes (directories skipped)
 */
export async function readZip(buf) {
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);

  // Find EOCD: scan backwards over at most 64KB+22 of trailing comment.
  let eocd = -1;
  const scanFrom = Math.max(0, buf.byteLength - 22 - 65536);
  for (let i = buf.byteLength - 22; i >= scanFrom; i--) {
    if (dv.getUint32(i, true) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a zip file (EOCD not found)');

  const count = dv.getUint16(eocd + 10, true);
  const cdOffset = dv.getUint32(eocd + 16, true);

  const dec = new TextDecoder();
  const entries = new Map();
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== SIG_CENTRAL) throw new Error('Corrupt central directory');
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOffset = dv.getUint32(p + 42, true);
    const name = dec.decode(u8.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith('/')) continue; // directory
    if (method !== 0 && method !== 8) continue; // unsupported compression

    // Local header's own name/extra lengths may differ from the central copy.
    if (dv.getUint32(localOffset, true) !== SIG_LOCAL) throw new Error(`Corrupt local header for ${name}`);
    const lNameLen = dv.getUint16(localOffset + 26, true);
    const lExtraLen = dv.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const raw = u8.subarray(dataStart, dataStart + compSize);
    entries.set(name, method === 0 ? raw.slice() : await inflateRaw(raw));
  }
  return entries;
}
