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

/** Canonical MCP cell numbers are 1-based; the browser RPC is 0-based. */
function numberedIndex(args) {
  if (args.cellIndex != null) return Number(args.cellIndex); // legacy/private
  if (args.cellNumber != null) return Number(args.cellNumber) - 1;
  return NaN;
}

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
      const i = numberedIndex(args);
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
      // The consolidated schema carries ranges on wolfbook_runCell. Keep the
      // old plural tool below as a compatibility alias for direct clients.
      if (args.startCell != null || args.endCell != null) {
        const start = args.startCell == null ? 0 : Number(args.startCell) - 1;
        const end = args.endCell == null ? null : Number(args.endCell) - 1;
        if (!Number.isInteger(start) || start < 0 || (end != null && (!Number.isInteger(end) || end < start))) {
          return fail('startCell/endCell must be a valid 1-based inclusive range');
        }
        const res = await registry.call(nb, 'runCells', { start, end });
        return text(res?.text || res?.summary || 'ran');
      }
      const i = numberedIndex(args);
      if (!Number.isInteger(i) || i < 0) return fail('Required: cellNumber (1-based)');
      // Routed through the TAB, not evaluated here, so the person watching sees
      // the result appear in their own notebook rather than nothing at all.
      const res = await registry.call(nb, 'runCell', { index: i });
      return text(res?.text || res?.summary || 'ran');
    },

    async wolfbook_runCells(args) {
      const nb = nbFor(args);
      const res = await registry.call(nb, 'runCells', {
        start: args.startCell == null ? 0 : Number(args.startCell) - 1,
        end: args.endCell == null ? null : Number(args.endCell) - 1,
      });
      return text(res?.summary || 'ran');
    },

    // ── editing ────────────────────────────────────────────────────────
    async wolfbook_editCell(args) {
      const nb = nbFor(args);
      const i = numberedIndex(args);
      if (!Number.isInteger(i) || i < 0) return fail('Required: cellNumber (1-based)');
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
      let index = args.index == null ? null : Number(args.index); // legacy/private
      if (index == null && args.afterCell != null) {
        const anchor = Number(args.afterCell) - 1;
        if (!Number.isInteger(anchor) || anchor < 0) return fail('afterCell must be 1-based');
        index = args.position === 'before' ? anchor : anchor + 1;
      }
      const res = await registry.call(nb, 'insertCells', {
        index,
        cells: cells.map((c) => ({
          kind: String(c.kind).startsWith('mark') ? 1 : 2,
          value: String(c.value ?? c.content ?? ''),
        })),
      });
      let summary = res?.summary || 'inserted';
      // Match the consolidated MCP contract: inserted code runs by default and
      // its output appears in the same browser notebook the person is viewing.
      if (args.evaluate !== false && cells.some((c) => !String(c.kind).startsWith('mark'))) {
        const model = await registry.call(nb, 'getContext');
        const at = index == null ? Math.max(0, model.cells.length - cells.length) : index;
        const ran = await registry.call(nb, 'runCells', { start: at, end: at + cells.length - 1 });
        summary += `; ${ran?.summary || 'evaluated inserted code'}`;
      }
      return changed(summary);
    },

    async wolfbook_deleteCell(args) {
      const nb = nbFor(args);
      const i = numberedIndex(args);
      if (!Number.isInteger(i) || i < 0) return fail('Required: cellNumber (1-based)');
      const res = await registry.call(nb, 'deleteCell', { index: i });
      return changed(res?.summary || `deleted cell ${i}` );
    },

    async wolfbook_moveCell(args) {
      const nb = nbFor(args);
      const from = args.fromIndex != null ? Number(args.fromIndex) : numberedIndex(args);
      const to = args.toIndex != null ? Number(args.toIndex)
        : (args.toPosition != null ? Math.max(0, Number(args.toPosition) - 1) : NaN);
      if (!Number.isInteger(from) || !Number.isInteger(to)) {
        return fail('Required: cellNumber and toPosition (both 1-based)');
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
