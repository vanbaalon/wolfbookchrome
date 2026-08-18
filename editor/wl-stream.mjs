// wl-stream.mjs — a CodeMirror 6 StreamParser for Wolfram Language.
//
// CodeMirror has no Wolfram mode, so this is the price of using it — but it is
// a small price: the same token rules as viewer/wl-highlight.js, restated in
// CM6's incremental, one-character-at-a-time form. The builtin list is shared
// verbatim, so `Table` and a user's `myFn` are told apart in the editor exactly
// as they are in the read-only view.
//
// StreamParser rather than a Lezer grammar on purpose: Wolfram's real grammar is
// large, and highlighting is all we need — a full parse would buy folding and
// structural selection at a cost far beyond this feature.

import { WL_BUILTINS } from '../vendor/wl-builtins.js';

const isSymbolChar = (ch) => /[A-Za-z0-9$]/.test(ch);

// Longest-first, so `===` is never read as `==` then `=`.
const OPERATORS = [
  ';;', '///@', '//@', '//.', '@@@', '///', '|->', ':>', '/;', '/.', '->', '<->',
  '===', '=!=', '==', '!=', '<=', '>=', '&&', '||', '^:=', '^=', ':=', '+=', '-=',
  '*=', '/=', '@@', '/@', '//', '<>', '~~', '...', '..', '::', '<<', '>>>', '>>',
  '++', '--', '**', '^^', '+', '-', '*', '/', '^', '=', '<', '>', '!', '&', '|',
  '@', '~', '?', ',', ';', ':', '.',
].sort((a, b) => b.length - a.length);

/**
 * The tokenizer as a STANDALONE function, called by name.
 *
 * It must not use `this`: CodeMirror invokes token() detached from the parser
 * object (and spreading the object into StreamLanguage.define detaches it
 * again), so `this.token(...)` threw
 *   TypeError: Cannot read properties of undefined (reading 'token')
 * the instant an editor was created.
 */
function tokenize(stream, state) {
  // commentDepth tracks NESTED (* … *), which Wolfram allows and a flat
  // scanner gets wrong; inString survives line breaks inside a string.
  // ── inside a nested comment ──────────────────────────────────────────
  if (state.commentDepth > 0) {
    while (!stream.eol()) {
      if (stream.match('(*')) { state.commentDepth++; continue; }
      if (stream.match('*)')) { state.commentDepth--; if (!state.commentDepth) break; continue; }
      stream.next();
    }
    return 'comment';
  }

  // ── inside a multi-line string ───────────────────────────────────────
  if (state.inString) {
    while (!stream.eol()) {
      if (stream.next() === '\\') { stream.next(); continue; }
      if (stream.current().endsWith('"')) { state.inString = false; break; }
    }
    return 'string';
  }

  if (stream.eatSpace()) return null;

  if (stream.match('(*')) { state.commentDepth = 1; return tokenize(stream, state); }

  if (stream.peek() === '"') {
    stream.next();
    state.inString = true;
    return tokenize(stream, state);
  }

  // ── named characters: \[Alpha] ───────────────────────────────────────
  if (stream.match(/^\\\[[A-Za-z]+\]/)) return 'escape';

  // ── numbers, with Wolfram's own forms ────────────────────────────────
  if (/[0-9]/.test(stream.peek()) || (stream.peek() === '.' && /[0-9]/.test(stream.string[stream.pos + 1] || ''))) {
    stream.match(/^[0-9]*\.?[0-9]+/);
    stream.match(/^\^\^[0-9A-Za-z.]+/);      // 2^^1010
    stream.match(/^`+[0-9.]*/);              // 0.024`36
    stream.match(/^\*\^[+-]?[0-9]+/);        // 3.6*^-19
    return 'number';
  }

  // ── slots: # ## #3 #name ─────────────────────────────────────────────
  if (stream.match(/^#+[A-Za-z0-9$]*/)) return 'slot';

  // ── blanks and patterns: _ __ ___ _Head ──────────────────────────────
  if (stream.match(/^_+[A-Za-z0-9$]*/)) return 'pattern';

  // ── symbols, contexts, named patterns ────────────────────────────────
  if (/[A-Za-z$`]/.test(stream.peek())) {
    const word = stream.match(/^[A-Za-z0-9$`]+/)[0];
    if (stream.match(/^_+[A-Za-z0-9$]*/)) return 'pattern';   // x_ , x_Integer
    if (word.includes('`')) return 'context';
    return WL_BUILTINS.has(word) ? 'builtin' : 'userSymbol';
  }

  if (/[[\](){}]/.test(stream.peek())) { stream.next(); return 'bracket'; }

  for (const op of OPERATORS) {
    if (stream.match(op)) return 'operator';
  }

  stream.next();
  return null;
}

export const wolframStreamParser = {
  name: 'wolfram',
  // commentDepth tracks NESTED (* … *), which Wolfram allows and a flat scanner
  // gets wrong; inString survives line breaks inside a string.
  startState: () => ({ commentDepth: 0, inString: false }),
  token: tokenize,
};
