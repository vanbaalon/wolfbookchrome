// notebooks.mjs — the notebooks an Overleaf tab has attached, and the reverse
// RPC that lets a tool call reach into that tab.
//
// Direction matters here. Everywhere else the browser calls this server; for an
// agent to read or edit the notebook, the SERVER must call the browser. The
// channel already exists — the tab holds `GET /v1/events` open — so a request is
// just a new event kind on it, answered by a POST back.
//
//     server → tab   event: rpc   {id, notebookId, method, params}
//     tab → server   POST /v1/rpc/<id>   {result} | {error}
//
// Liveness is the SSE connection itself. A tab that closes takes its notebooks
// with it, because a notebook an agent can see but not reach is worse than one
// it cannot see at all.

import crypto from 'node:crypto';

const RPC_TIMEOUT_MS = 20000;

export class NotebookRegistry {
  constructor({ onChange } = {}) {
    /** @type {Map<string, {id, projectId, projectName, fileName, path, subscriber, cells}>} */
    this.notebooks = new Map();
    this.pending = new Map();          // rpc id → {resolve, reject, timer}
    this.onChange = onChange || (() => {});
  }

  /** Paths as an agent sees them, prefixed so a file on disk is never implied. */
  paths() {
    return [...this.notebooks.values()].map((n) => n.path);
  }

  find(needle) {
    if (!needle) {
      // With exactly one notebook attached, not naming it is unambiguous.
      return this.notebooks.size === 1 ? [...this.notebooks.values()][0] : null;
    }
    const want = String(needle).toLowerCase();
    for (const nb of this.notebooks.values()) {
      if (nb.path.toLowerCase() === want || nb.fileName.toLowerCase() === want) return nb;
    }
    // Fall back to a suffix match, the way a person would refer to it.
    for (const nb of this.notebooks.values()) {
      if (nb.path.toLowerCase().endsWith(want)) return nb;
    }
    return null;
  }

  attach({ projectId, projectName, fileName }, subscriber) {
    const path = `overleaf:${projectName || projectId}/${fileName}`;
    // Keyed on project+file: the same notebook open in two tabs must not become
    // two entries an agent could drive independently.
    const existing = [...this.notebooks.values()]
      .find((n) => n.projectId === projectId && n.fileName === fileName);
    if (existing) {
      existing.subscriber = subscriber;      // the newer tab takes over
      this.onChange();
      return existing;
    }
    const nb = {
      id: crypto.randomUUID(),
      projectId, projectName, fileName, path, subscriber,
      attachedAt: new Date().toISOString(),
    };
    this.notebooks.set(nb.id, nb);
    this.onChange();
    return nb;
  }

  detach(id) {
    if (this.notebooks.delete(id)) this.onChange();
  }

  /** Drop everything a departing SSE subscriber was serving. */
  detachSubscriber(subscriber) {
    let changed = false;
    for (const [id, nb] of this.notebooks) {
      if (nb.subscriber === subscriber) { this.notebooks.delete(id); changed = true; }
    }
    if (changed) this.onChange();
  }

  /**
   * Ask the tab to do something and wait for its answer.
   * Bounded, so a wedged tab surfaces as a tool error rather than a hung agent.
   */
  call(nb, method, params = {}, timeoutMs = RPC_TIMEOUT_MS) {
    if (!nb || !nb.subscriber) return Promise.reject(new Error('that notebook is no longer open'));
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`the Overleaf tab did not answer "${method}" within ${timeoutMs / 1000}s`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        nb.subscriber.write(`event: rpc\ndata: ${JSON.stringify({ id, notebookId: nb.id, method, params })}\n\n`);
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error('could not reach the Overleaf tab'));
      }
    });
  }

  /** End-to-end reachability, not merely the server's remembered registry. */
  async status(timeoutMs = 2000) {
    return Promise.all([...this.notebooks.values()].map(async (nb) => {
      try {
        const reply = await this.call(nb, 'ping', {}, timeoutMs);
        return {
          path: nb.path,
          fileName: nb.fileName,
          reachable: true,
          activeFile: reply?.path || nb.fileName,
        };
      } catch (e) {
        return {
          path: nb.path,
          fileName: nb.fileName,
          reachable: false,
          error: String(e?.message || e),
        };
      }
    }));
  }

  /** The tab's answer, from POST /v1/rpc/<id>. */
  settle(id, { result, error }) {
    const entry = this.pending.get(id);
    if (!entry) return false;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    if (error) entry.reject(new Error(error));
    else entry.resolve(result);
    return true;
  }
}
