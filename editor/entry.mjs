// entry.mjs — the CodeMirror 6 bundle the viewer loads.
//
// Bundled rather than vendored file-by-file because CM6 ships as dozens of
// interdependent npm packages; esbuild flattens them into one ES module that a
// Chrome extension can serve as a web-accessible resource.
//
// Kept deliberately small: an editor for ONE cell, created on demand. CM6 is
// designed for many instances, but a 138-cell notebook still should not build
// 138 editors up front — the viewer mounts one when a cell is clicked and
// disposes it on blur.

import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection } from '@codemirror/view';
import { EditorState, Compartment } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { StreamLanguage, HighlightStyle, syntaxHighlighting, bracketMatching } from '@codemirror/language';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { tags } from '@lezer/highlight';
import { wolframStreamParser } from './wl-stream.mjs';

// Map our own token names onto Lezer tags, then style those tags with the same
// palette the read-only viewer uses, so a cell does not change colour when it
// becomes editable.
const wolfram = StreamLanguage.define({
  ...wolframStreamParser,
  tokenTable: {
    builtin: tags.keyword,
    userSymbol: tags.variableName,
    pattern: tags.labelName,
    slot: tags.macroName,
    context: tags.namespace,
    operator: tags.operator,
    bracket: tags.bracket,
    escape: tags.escape,
  },
});

const wolframHighlight = HighlightStyle.define([
  { tag: tags.comment, color: '#6e7781', fontStyle: 'italic' },
  { tag: tags.string, color: '#0a3069' },
  { tag: tags.number, color: '#0550ae' },
  { tag: tags.keyword, color: '#8250df' },      // builtin
  { tag: tags.variableName, color: '#1f2328' }, // the notebook's own symbols
  { tag: tags.namespace, color: '#6639ba' },
  { tag: tags.labelName, color: '#116329', fontStyle: 'italic' },
  { tag: tags.macroName, color: '#116329', fontWeight: '600' },
  { tag: tags.operator, color: '#cf222e' },
  { tag: tags.bracket, color: '#57606a' },
  { tag: tags.escape, color: '#0550ae', fontWeight: '600' },
]);

const theme = EditorView.theme({
  '&': { fontSize: '13px', backgroundColor: '#f6f8fa', borderRadius: '6px' },
  '&.cm-focused': { outline: '2px solid #2c6e49', outlineOffset: '0' },
  '.cm-content': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', padding: '8px 0' },
  '.cm-gutters': { backgroundColor: '#f6f8fa', border: 'none', color: '#8c959f' },
  '.cm-activeLine': { backgroundColor: '#eef1f4' },
  '.cm-scroller': { lineHeight: '1.45', overflowX: 'auto' },

  // SELECTION.
  //
  // drawSelection() hides the native selection and paints its own layer, so
  // without these rules the highlight is whatever the host page happens to
  // provide — which showed the middle of a multi-line selection but neither the
  // first nor the last line, because those were drawn by the (now hidden)
  // native selection. Both layers are styled, so it looks the same either way.
  '.cm-selectionBackground': { backgroundColor: '#b5d5ff' },
  '&.cm-focused .cm-selectionBackground': { backgroundColor: '#9fc9ff' },
  '.cm-content ::selection': { backgroundColor: '#9fc9ff' },
  '.cm-selectionLayer .cm-selectionBackground': { borderRadius: '2px' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: '#1f2328', borderLeftWidth: '2px' },
  '&.cm-focused .cm-matchingBracket': { backgroundColor: '#dbeafe', outline: '1px solid #93c5fd' },
});

/**
 * Mount an editor for one cell.
 *
 * @param {HTMLElement} host
 * @param {{doc: string, onRun?: Function, onDone?: Function, onChange?: Function}} opts
 */
export function mountEditor(host, opts = {}) {
  const runKeys = keymap.of([
    {
      // Shift-Enter evaluates, as in the notebook. Mod-Enter too, since muscle
      // memory differs between front ends.
      key: 'Shift-Enter',
      run: () => { opts.onRun?.(view.state.doc.toString()); return true; },
    },
    { key: 'Mod-Enter', run: () => { opts.onRun?.(view.state.doc.toString()); return true; } },
    { key: 'Escape', run: () => { opts.onDone?.(view.state.doc.toString()); return true; } },
  ]);

  // `root` matters: this editor lives inside the viewer's SHADOW ROOT, and
  // without it CodeMirror calls document.getSelection() — which never sees a
  // selection inside a shadow tree, so focus and typing misbehave.
  const root = host.getRootNode();

  const view = new EditorView({
    parent: host,
    root: root instanceof ShadowRoot || root instanceof Document ? root : undefined,
    state: EditorState.create({
      doc: String(opts.doc ?? ''),
      extensions: [
        lineNumbers(),
        history(),
        drawSelection(),
        highlightActiveLine(),
        bracketMatching(),
        closeBrackets(),
        // runKeys FIRST, so Shift-Enter is not swallowed by the default
        // "insert newline" binding.
        runKeys,
        keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, indentWithTab]),
        wolfram,
        syntaxHighlighting(wolframHighlight),
        theme,
        EditorView.updateListener.of((u) => { if (u.docChanged) opts.onChange?.(u.state.doc.toString()); }),
      ],
    }),
  });

  return {
    view,
    focus: () => view.focus(),
    getValue: () => view.state.doc.toString(),
    destroy: () => view.destroy(),
  };
}
