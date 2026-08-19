/** Repair legacy single-backslash Wolfram escapes inside JSON strings. */
export function escapeInvalidJsonBackslashes(raw) {
  const text = String(raw);
  let out = '', inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (!inString) {
      out += ch;
      if (ch === '"') inString = true;
      continue;
    }
    if (ch === '"') { out += ch; inString = false; continue; }
    if (ch !== '\\') { out += ch; continue; }
    const next = text[i + 1];
    if (next && '"\\/bfnrt'.includes(next)) { out += ch + next; i++; continue; }
    if (next === 'u' && /^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) {
      out += text.slice(i, i + 6); i += 5; continue;
    }
    out += '\\\\';
  }
  return out;
}

export function parseNotebookJson(raw) {
  try { return JSON.parse(String(raw)); }
  catch (originalError) {
    const repaired = escapeInvalidJsonBackslashes(raw);
    if (repaired === String(raw)) throw originalError;
    return JSON.parse(repaired);
  }
}
