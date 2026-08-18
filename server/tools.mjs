// tools.mjs — the MCP tool surface wolfbook-serve answers for.
//
// Deliberately a SUBSET, and honest about it. The tools here either act on a
// notebook open in an Overleaf tab (routed through the reverse RPC) or on this
// process's own kernel. Anything a VS Code window offers that we cannot do — the
// debugger, wolfslide, the Oberon agent surface — is simply absent, so an agent
// discovers the boundary by looking rather than by a call failing oddly.
//
// NOT PRESENT ON PURPOSE: wolfbook_saveNotebook. Everything an agent changes
// lives in the browser's memory until a person presses Save, which is the same
// position as an AI editing an unsaved buffer in a local editor. Writing to
// someone's Overleaf project is the one irreversible, outward-facing step, and
// it stays a human action rather than becoming a tool call.

const text = (s) => ({ content: [{ type: 'text', text: String(s) }], isError: false });
const fail = (s) => ({ content: [{ type: 'text', text: String(s) }], isError: true });

/**
 * Every mutating tool says the change is unsaved — here, not in the tab.
 *
 * An agent must never be able to conclude it has published something. Leaving
 * that to whatever wording the browser happened to return made the guarantee
 * depend on the least reliable part of the chain; stating it at the boundary
 * makes it unconditional.
 */
const UNSAVED = 'This change is in the browser only. '
  + 'It reaches the Overleaf project when the person presses Save in the tab.';
const changed = (summary) => text(`${summary}\n${UNSAVED}`);

/** A compact, agent-readable view of a notebook. */
function describeNotebook(nb, model) {
  const lines = [`Notebook: ${nb.path}`,
                 `Overleaf project: ${nb.projectName || nb.projectId}`,
                 `Cells: ${model.cells.length}`,
                 ''];
  model.cells.forEach((cell, i) => {
    const kind = cell.kind === 1 ? 'markdown' : 'code';
    const outs = (cell.outputs || []).length;
    lines.push(`[${i}] ${kind}${outs ? ` (${outs} output${outs === 1 ? '' : 's'})` : ''}`);
    const body = String(cell.value ?? '');
    lines.push(body.length > 2000 ? body.slice(0, 2000) + `\n… (${body.length - 2000} more chars)` : body);
    lines.push('');
  });
  return lines.join('\n');
}

export function makeToolSurface({ registry, kernel, coalition }) {
  const nbFor = (args) => {
    const nb = registry.find(args.notebook);
    if (!nb) {
      const open = registry.paths();
      throw new Error(open.length
        ? `No such notebook. Open notebooks: ${open.join(', ')}`
        : 'No Overleaf notebook is attached. Open a .wb in Overleaf with the Wolfbook extension.');
    }
    return nb;
  };

  const TOOLS = {
    // ── discovery ──────────────────────────────────────────────────────
    async wolfbook_kernelStatus() {
      return text(JSON.stringify({
        client: coalition.clientId,
        wolframVersion: kernel.wolframVersion,
        busy: kernel.busy,
        ready: kernel.ready,
        notebooks: registry.paths(),
      }, null, 2));
    },

    // ── reading ────────────────────────────────────────────────────────
    async wolfbook_getNotebookContext(args) {
      const nb = nbFor(args);
      // Read the LIVE model each call: the person is editing it at the same time,
      // so a snapshot taken at attach would go stale immediately.
      const model = await registry.call(nb, 'getContext');
      return text(describeNotebook(nb, model));
    },

    async wolfbook_searchCells(args) {
      const nb = nbFor(args);
      const model = await registry.call(nb, 'getContext');
      const needle = String(args.query || args.pattern || '').toLowerCase();
      if (!needle) return fail('Required: query');
      const hits = [];
      model.cells.forEach((cell, i) => {
        const body = String(cell.value ?? '');
        if (body.toLowerCase().includes(needle)) {
          hits.push(`[${i}] ${cell.kind === 1 ? 'markdown' : 'code'}\n${body.slice(0, 400)}`);
        }
      });
      return text(hits.length ? hits.join('\n\n') : `No cell contains ${JSON.stringify(needle)}.`);
    },

    async wolfbook_getCellOutput(args) {
      const nb = nbFor(args);
      const model = await registry.call(nb, 'getContext');
      const i = Number(args.cellIndex ?? args.cellNumber);
      const cell = model.cells[i];
      if (!cell) return fail(`No cell ${i}; the notebook has ${model.cells.length}.`);
      const items = (cell.outputs || []).flatMap((o) => o.items || []);
      const plain = items.filter((it) => it.mime === 'text/plain').map((it) => it.data);
      return text(plain.join('\n') || '(no text output stored for that cell)');
    },

    // ── running ────────────────────────────────────────────────────────
    async wolfbook_evaluateExpression(args) {
      const expr = args.expression;
      if (!expr) return fail('Required: expression');
      const out = await kernel.evalCell(String(expr), { format: args.outputForm });
      const parts = [out.text || '(no value)'];
      if (out.print?.length) parts.push('Print:', ...out.print);
      if (out.messages?.length) parts.push('Messages:', ...out.messages);
      return text(parts.join('\n'));
    },

    async wolfbook_runCell(args) {
      const nb = nbFor(args);
      const i = Number(args.cellIndex ?? args.cellNumber ?? args.cellId);
      if (!Number.isInteger(i)) return fail('Required: cellIndex (0-based)');
      // Routed through the TAB, not evaluated here, so the person watching sees
      // the result appear in their own notebook rather than nothing at all.
      const res = await registry.call(nb, 'runCell', { index: i });
      return text(res?.text || res?.summary || 'ran');
    },

    async wolfbook_runCells(args) {
      const nb = nbFor(args);
      const res = await registry.call(nb, 'runCells', {
        start: Number(args.startCell ?? 0),
        end: args.endCell == null ? null : Number(args.endCell),
      });
      return text(res?.summary || 'ran');
    },

    // ── editing ────────────────────────────────────────────────────────
    async wolfbook_editCell(args) {
      const nb = nbFor(args);
      const i = Number(args.cellIndex ?? args.cellNumber);
      if (!Number.isInteger(i)) return fail('Required: cellIndex (0-based)');
      if (typeof args.content !== 'string' && typeof args.value !== 'string') {
        return fail('Required: content');
      }
      const res = await registry.call(nb, 'editCell', {
        index: i, value: args.content ?? args.value,
      });
      return changed(res?.summary || `edited cell ${i}`);
    },

    async wolfbook_insertCells(args) {
      const nb = nbFor(args);
      const cells = args.cells || [{ kind: args.kind || 'code', value: args.content ?? args.value ?? '' }];
      const res = await registry.call(nb, 'insertCells', {
        index: args.index == null ? null : Number(args.index),
        cells: cells.map((c) => ({
          kind: String(c.kind).startsWith('mark') ? 1 : 2,
          value: String(c.value ?? c.content ?? ''),
        })),
      });
      return changed(res?.summary || 'inserted');
    },

    async wolfbook_deleteCell(args) {
      const nb = nbFor(args);
      const i = Number(args.cellIndex ?? args.cellNumber);
      if (!Number.isInteger(i)) return fail('Required: cellIndex (0-based)');
      const res = await registry.call(nb, 'deleteCell', { index: i });
      return changed(res?.summary || `deleted cell ${i}` );
    },

    async wolfbook_moveCell(args) {
      const nb = nbFor(args);
      const from = Number(args.fromIndex ?? args.cellIndex);
      const to = Number(args.toIndex);
      if (!Number.isInteger(from) || !Number.isInteger(to)) {
        return fail('Required: fromIndex and toIndex (0-based)');
      }
      const res = await registry.call(nb, 'moveCell', { from, to });
      return changed(res?.summary || `moved cell ${from} → ${to}`);
    },
  };

  return {
    names: Object.keys(TOOLS),
    async invoke(name, args) {
      const fn = TOOLS[name];
      if (!fn) {
        return fail(`wolfbook-serve does not implement ${name}. It offers: ${Object.keys(TOOLS).join(', ')}`);
      }
      try {
        return await fn(args || {});
      } catch (e) {
        return fail(String(e?.message || e));
      }
    },
  };
}
