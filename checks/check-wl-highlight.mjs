// Unit checks for the Wolfram tokenizer (viewer/wl-highlight.js).
import { highlightWolfram } from '../viewer/wl-highlight.js';
import { WL_BUILTINS } from '../vendor/wl-builtins.js';

let failures = 0;
const check = (label, cond, extra) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}${extra ? `  — ${extra}` : ''}`);
  if (!cond) failures++;
};
/**
 * Extract [class, text] pairs, so assertions read like the rendered result.
 * Entities are decoded: the emitted HTML escapes `>` and `&`, so an operator
 * like `->` appears as `-&gt;` in the markup.
 */
const unesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const toks = (src) => [...highlightWolfram(src).matchAll(/<span class="wl-hl-(\w+)">([^<]*)<\/span>/g)]
  .map((m) => [m[1], unesc(m[2])]);
const has = (src, cls, text) => toks(src).some(([c, t]) => c === cls && t === text);

check('builtin list loaded', WL_BUILTINS.size > 3000, WL_BUILTINS.size + ' symbols');

// The distinction the whole exercise is about.
check('builtin symbol', has('Table[i, {i, 3}]', 'sym', 'Table'));
check('user symbol', has('myVar + 1', 'usr', 'myVar'));
check('capitalised user symbol is NOT a builtin',
  has('BSolver2D[x]', 'usr', 'BSolver2D'), JSON.stringify(toks('BSolver2D[x]')[0]));
check('Eigensystem is a builtin, EigenSystem is not',
  has('Eigensystem[m]', 'sym', 'Eigensystem') && has('EigenSystem[m]', 'usr', 'EigenSystem'));

// Comments nest in Wolfram — a single regex gets this wrong.
const nested = '(* outer (* inner *) still comment *) Abs';
check('nested comments consumed whole', has(nested, 'cmt', '(* outer (* inner *) still comment *)'));
check('code after a nested comment resumes', has(nested, 'sym', 'Abs'));
check('unterminated comment does not hang', highlightWolfram('(* oops').length > 0);

// Strings.
check('string', has('f["hi"]', 'str', '"hi"'));
check('escaped quote inside string', has('"a\\"b"', 'str', '"a\\"b"'));
check('brackets inside a string are not code', !has('"[not code]"', 'brk', '['));

// Numbers, in the forms notebooks actually use.
check('integer', has('42', 'num', '42'));
check('real', has('1.5', 'num', '1.5'));
check('precision mark', has('0.0244`36', 'num', '0.0244`36'));
check('scientific *^', has('3.64*^-19', 'num', '3.64*^-19'));
check('base-n literal', has('2^^1010', 'num', '2^^1010'));

// Patterns and slots.
check('named pattern', has('f[x_] := x', 'pat', 'x_'));
check('typed pattern', has('f[x_Integer] := x', 'pat', 'x_Integer'));
check('bare blank', has('f[_] := 1', 'pat', '_'));
check('triple blank', has('f[x___] := 1', 'pat', 'x___'));
check('slot', has('# + 1 &', 'slot', '#'));
check('numbered slot', has('#2 &', 'slot', '#2'));

// Operators and structure.
check('rule operator', has('a -> b', 'op', '->'));
check('delayed rule', has('a :> b', 'op', ':>'));
check('set delayed', has('f := 1', 'op', ':='));
check('longest operator wins', has('a === b', 'op', '===') && !has('a === b', 'op', '=='));
check('bracket', has('f[1]', 'brk', '['));

// Contexts and named characters.
check('context prefix', has('BSolver2D`Path', 'ctx', 'BSolver2D`'));
check('named character', has('\\[Alpha] + 1', 'esc', '\\[Alpha]'));

// Safety and fidelity.
check('html is escaped', highlightWolfram('a < b && c > d').includes('&lt;'));
check('no raw < survives', !/<span[^>]*>[^<]*<(?!\/span)/.test(highlightWolfram('x < y')));
const round = 'Module[{a = 1}, (* note *) Table[a^i, {i, 3}]]';
const stripped = highlightWolfram(round).replace(/<[^>]+>/g, '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
check('text is preserved exactly', stripped === round, JSON.stringify(stripped.slice(0, 40)));

// Performance guard: a big cell must not be pathological.
const big = 'Table[Sin[x^2] + myFn[y], {i, 100}]\n'.repeat(2000);
const t0 = Date.now();
highlightWolfram(big);
const ms = Date.now() - t0;
check('70k chars highlight quickly', ms < 1500, ms + 'ms');

process.exit(failures ? 1 : 0);
