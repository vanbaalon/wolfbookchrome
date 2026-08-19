# Wolfbook for Overleaf — Chrome extension

View Wolfbook `.wb` notebooks inside Overleaf, and hand them to a local Wolfbook
installation to run.

Two tiers, degrading gracefully:

| | What you get |
|---|---|
| **Extension only** | Read-only notebook view: markdown with KaTeX math, syntax-highlighted code cells, and the stored outputs exactly as the notebook's author last evaluated them (equations, plots, tables). No kernel needed. |
| **+ `wolfbook-serve` running** | Every code cell gets a **▶ Run** button and results come back as the kernel's OWN output — real SVG plots, typeset maths, untruncated. **No VS Code needed at all**, only wolfbook *installed*. |
| **+ VS Code running (fallback)** | Same Run buttons over MCP, with a kernel picker. Results are text: MCP truncates and cannot return images. |

The extension prefers `wolfbook-serve` whenever it answers, and falls back to
MCP otherwise. Neither requires the notebook to be open in VS Code.

Design notes and roadmap: `Internal Docs/misc/overleaf-chrome-extension-plan.md`.

## Phase 1 status — the viewer

Implemented and checked:

- `.wb` → rendered notebook: markup cells (markdown + KaTeX), code cells with
  `In[n]:=` taken from the stored `Out[n]`, and every output kind found in the
  corpus — pre-rendered KaTeX, inline SVG, `<img>` plots, `<details>`, errors.
- **Acquisition via Overleaf's own Download link.** Overleaf classifies `.wb` as
  a binary file and renders a `file-view` whose link both names the file
  (`download="…"`) and points at its bytes (`/project/<id>/blob/<sha>`). The
  notebook is fetched from there directly; the project zip
  (`/project/<id>/download/zip`, unzipped with the browser-native
  `DecompressionStream`) is pulled **lazily**, only when the notebook references
  `img/…`. CodeMirror is used as a fast path in the rarer case where Overleaf
  opens the `.wb` as editable text.
- **Wolfram syntax highlighting** that distinguishes **builtins from the
  notebook's own symbols** — `Module` and `Eigensystem` colour differently from
  `simultaneousDiag` and `evals` — plus patterns (`x_`, `_Head`), slots (`#1`),
  operators, nested `(* … *)` comments and WL number syntax (``0.024`36``,
  `3.6*^-19`, `2^^1010`). See "Highlighting" below.
- **Markdown**: headings, `$…$`/`$$…$$` via KaTeX, ``` and **`~~~` fences**
  (with the fence's language highlighted), GFM tables, nested lists,
  strikethrough, and raw HTML.
- **Copy LaTeX** on any equation — the source is already in the markup as
  base64, and in an Overleaf tab that is the most useful thing the viewer can
  offer.
- **Notebook / Source toggle**, refresh, and honest status
  (`17 cells · 8 outputs · 3 image(s) not in project`).
- Interactive controls (Manipulate sliders) shown but disabled and labelled
  `static preview`, rather than silently dead.
- Missing images say so, naming the file, instead of showing a broken icon.

## Evaluating on your own kernel

Each code cell gains a **▶** button and the toolbar gains **Run all** / **Stop**.

### Preferred: wolfbook-serve (`server/`)

It needs wolfbook **installed** in VS Code, not running:

```bash
cd server
node cli.mjs start      # detached; prints the URL and the token
node cli.mjs enable     # …or run it at login (launchd / systemd user unit)
node cli.mjs token      # print the token again
node cli.mjs status | stop | restart | logs | disable
```

The extension finds it on ports 27300–27309. The **token is asked for inside the
panel, at the first evaluation** — never on page load, and never through a
browser dialog: opening a notebook to read it needs no credentials. The token is
persisted server-side, so you paste it once, not once per restart.

It is not optional, though: every request evaluates arbitrary Wolfram code, so a
page that merely guesses the port must not get through.

### Editing (CodeMirror 6)

Click any code cell to edit it; **Shift-Enter** evaluates, **Escape** closes.
Edited cells are badged — the file in the Overleaf project is untouched, and
editing only changes what gets evaluated.

- Offered only when a cell can actually be run, since editing with nothing to
  evaluate against would change nothing anywhere.
- The 362 KB bundle is imported on the **first click into a cell**, so a reader
  who never edits never downloads it, and the viewer stays read-only if it fails.
- Editors are created per cell on demand and destroyed on blur. CodeMirror
  handles many instances well, but a 138-cell notebook should not build 138.
- **Monaco was considered and rejected**: ~5 MB, no Wolfram support (a tokenizer
  would be needed regardless), and it is not built for hundreds of instances.

`editor/` holds the source; `./editor/build.sh` regenerates
`extension/vendor/codemirror.bundle.js`. **The bundle is committed**, so loading the
extension still needs no npm and no build step — only changing the editor does.
The Wolfram mode is a CM6 `StreamLanguage` sharing the same builtin list as the
read-only highlighter, so a cell does not change colour when it becomes editable.

Verified end to end by `checks/check-serve-integration.mjs` — a real server, a
real kernel, a real browser:

```
ok  a Plot renders as a real IMAGE, not a text description
      http://127.0.0.1:27300/img/wl_….svg?token=…
ok  the browser successfully loaded the image      480x285
ok  an integral is typeset with KaTeX in the browser
ok  large output is not truncated                  4521 chars
ok  kernel state persists between cells
```

The server returns the kernel's own HTML; the viewer sanitises it exactly like a
stored output, points its `img/` paths at the server, and typesets the LaTeX it
carries with the KaTeX already vendored here. The server therefore needs no
KaTeX of its own.

### Fallback: MCP

Used when `wolfbook-serve` is not running. Text only, and truncating — it is an
AI transport. The kernel picker and the **Text ⇄ Math** toggle belong to this
path (the server always returns rich HTML, so both are hidden when it is in use).

- **Pick your kernel.** A machine often has several VS Code windows open, each
  with its own kernels, and the MCP server refuses to guess between them — it
  answers "No session target set" rather than risk running in the wrong window.
  The toolbar therefore offers a picker, grouped by window and showing each
  kernel's label, default flag and idle/busy state. The choice is remembered in
  `chrome.storage.local`, and the list refreshes whenever the picker is opened.
- The picker is populated from the server's plain `GET /workers` endpoint, which
  needs no MCP session or handshake.
- **Routing is per call, not a session target.** `client_id` and `kernel_id` go
  with every evaluation instead of calling `wolfbook_setTarget` once. A session
  target lives on the MCP session, and an MV3 service worker may drop and
  recreate that at any time — silently losing the choice. Per-call routing has
  no such state to lose.
- Evaluation goes through `wolfbook_evaluateExpression` on the local MCP server
  (`127.0.0.1:27182`), which talks to the kernel directly — no notebook needs to
  be open in VS Code.
- **`multiLine: true` is essential**, and is why this works on real notebooks: a
  cell is usually several statements, and this evaluates each as its own
  expression, exactly as shift-enter does. Sent as one expression, most real
  cells would simply fail to parse.
- **Run all is sequential on purpose.** Cells share one kernel and normally
  depend on the ones above them, so evaluating them in parallel would be wrong.
- **Math mode** requests `outputForm: "TeXForm"` and typesets the result with
  the KaTeX already loaded; if the result is not valid TeX it silently falls
  back to plain text.
- **A live result is never mixed into the stored outputs.** It appears in its own
  green-edged block labelled `local kernel`, because the stored output is what
  the project contains while this is what *your* machine just computed. Nothing
  is written back to Overleaf.
- Results are text. Plots evaluate fine but come back as a text description —
  which is exactly why `wolfbook-serve` exists.

## Standalone: a `.wb` outside Overleaf

`extension/viewer/standalone.html` is an extension PAGE — not a content script — because
Chrome never renders a `.wb` at all. An unknown type on `file://` is
**downloaded, not displayed**, so there is no document for a script to attach
to; the only way to show the notebook is a page of our own, told where the file
is via `?src=`.

```
Finder "Open With"                     toolbar popup / drag-drop
        │                                          │
  Wolfbook Viewer (Chrome).app                     │
  (AppleScript applet: `on open`)                  │
        │  open -a "Google Chrome" …               │
        ▼                                          ▼
  chrome-extension://<id>/viewer/standalone.html?src=file:///…
        │
        └── same wb-viewer.js, same CSS, same optional wolfbook-serve
```

Points that each cost something to learn:

- **A shell script in an `.app` does not receive dropped files.** Finder sends
  them as an Apple Event (`odoc`), never as `argv`, so the stub is an AppleScript
  applet with an `on open` handler — compiled by `osacompile`, not copied.
- **The stub declares the type as `LSHandlerRank: Alternate`, role `Viewer`**,
  and never calls `LSSetDefaultRoleHandlerForContentType`. That is the whole
  difference between joining the "Open With" list and hijacking double-click.
  Verify with `LSCopyDefaultRoleHandlerForContentType` — it must still answer
  `com.microsoft.VSCode`.
- **An unpacked extension's id comes from the folder it was loaded from**, so it
  cannot be hard-coded; the installer reads it back out of Chrome's own profile.
  Watch the empty-path trap there: `realpath('')` is the *current directory*, so
  a naive path comparison matched every extension that records no path.
- **Chrome's own `Info.plist` is not an option.** It is inside a signed bundle;
  editing it breaks the signature.
- **`fetch('file://…')` needs "Allow access to file URLs"**, which is why the
  picker and drag-and-drop exist beside it — they need no permission at all, and
  the page detects the missing switch with `chrome.extension.isAllowedFileSchemeAccess`
  rather than guessing from a failed fetch.
- **The page cannot write back** to the file it was opened from, so edits leave
  via **Download .wb**. Silently rewriting a double-clicked file would be the
  wrong default even if a tab could.
- `standalone.js` falls back to `import.meta.url` when `chrome.runtime` is
  absent — which is the only reason `check-standalone.mjs` can drive the real
  page over plain HTTP, with no extension loaded.

`tools/register-chrome-viewer-macos.sh` builds and registers the stub;
`--uninstall` removes it.

## Saving back to Overleaf

Edit a cell and a **Save to Overleaf** button appears, naming how many cells will
be written. It uses Overleaf's OWN upload endpoint — captured from its
drag-and-drop uploader, not guessed:

```
POST /project/<projectId>/upload?folder_id=<folderId>
  x-csrf-token: <read from the page>
  multipart: relativePath="null", targetFolderId, name, type, qqfile=<bytes>
```

Uploading the same name into the same folder **replaces** the file and creates a
new version — confirmed by re-uploading an existing file and seeing the identical
request, with no delete and no separate update call. The session cookie is never
handled: the request is same-origin, so the browser attaches it.

Three properties this deliberately holds to, each pinned by `checks/check-save.mjs`:

- **Only edited cell `value`s change.** Stored outputs, cell metadata, ids and
  every untouched cell are preserved byte-for-byte. Outputs computed in the
  browser are *not* written — they reference images that exist only in a temp
  directory on the reader's machine.
- **A stale save is refused.** Overleaf's Download link is content-addressed
  (`/blob/<sha>`), so the sha doubles as a version token: if it changed since the
  file was opened, the save stops and says "Reload before saving". Uploading
  replaces the whole file and there is no OT merge for a binary file, so a silent
  save would destroy a collaborator's work.
- **No websocket, no OT.** The capture showed binary files bypass the
  collaborative-edit layer entirely, so this is the native path rather than a
  reverse-engineered one.

Not yet: the interactive 2D/3D viewers (the mesh and tooltip JSON are already produced — see
`data-wl-mesh-src` / `data-wl-plot-src` — so this is wiring, not new machinery).

## Audit against the VS Code notebook

Twenty things the notebook does that this viewer did not. Implemented unless
marked otherwise.

**Reading a notebook**
1. Cells fill the panel width — they were capped at 980px, leaving the pane empty.
2. Long code lines scroll horizontally inside their cell (a flex item defaults
   to `min-width:auto`, so a long line widened the whole notebook instead).
3. Word-wrap toggle, for when scrolling per cell gets tiring.
4. Output folding, for results that run to pages.
5. Failed cells are marked, so a scan finds them.

**Running**
6. `In[n]` adopts the KERNEL's own evaluation number after a run — re-running
   and seeing `In[3]` become `In[12]` is how you tell what this session has done.
7. `Out[n]` on live results, matching the input.
8. Evaluation duration, the number you watch to judge whether something is stuck.
9. Run above / run below, the usual way to rebuild state in a cold notebook.
10. Abort a running evaluation (`POST /v1/interrupt`).
11. Shift-Enter and ⌘-Enter run the focused cell.

**Editing**
12. Markdown cells are editable (double-click, since single-click belongs to
    links in the prose).
13. Move a cell up or down.
14. Change cell type, code ⇄ markdown.
15. Insert above as well as below.
16. Copy a cell's source.
17. Clear one cell's output, or all of them.
18. **Undo** (⌘Z or ↶) for every structural operation — deleting a cell was
    otherwise unrecoverable, since the in-memory model is the only copy of
    unsaved work.
19. ⌘S saves to Overleaf.
20. Editor selection is visible across every line. `drawSelection()` hides the
    native selection and paints its own layer; unstyled, it showed the middle of
    a multi-line selection but neither the first line nor the last.

**Not done**, and worth knowing: find/replace across the notebook, drag-to-reorder,
collapsing a cell's *input*, multi-cell selection, a kernel restart control, and
undo for *text* edits beyond CodeMirror's own per-cell history.

## Install

```bash
./sync-assets.sh          # vendor the extension's own KaTeX + renderer CSS
```

Then Chrome → `chrome://extensions` → Developer mode → **Load unpacked** → the
repository's `extension/` folder. Open an Overleaf project containing a `.wb`
and click it.

Upload the notebook's `img/<notebook-name>/` folder to the project too, or plots
will render as "not in this Overleaf project" placeholders.

## How it renders so faithfully

A `.wb` output is **HTML the wolfbook renderer already produced** — overwhelmingly
pre-rendered KaTeX. So the viewer does not re-typeset anything; it re-hosts that
markup and styles it with **the extension's own stylesheets**, copied verbatim by
`sync-assets.sh`:

- `extension/vendor/katex-css.js` — KaTeX CSS with every woff2 font inlined as a data URI
  (no CDN, works offline, no layout jump).
- `extension/vendor/renderer-css.js` — `WL_CSS`, which styles wolfbook's custom elements
  (`wrow`, `wfrac`, `wsub`, …).
- `extension/vendor/katex.mjs` — used **only** for `$…$` in markdown cells, which is
  source text rather than pre-rendered output.

Maintaining a hand-written stylesheet instead would mean a second copy that
drifts. Re-run `sync-assets.sh` after upgrading the extension.

### Highlighting

`extension/viewer/wl-highlight.js` is a single-pass Wolfram tokenizer (linear, no
backtracking, ~20 ms for 70 k characters). It exists because the two
alternatives are both wrong for this job:

- The extension's own `applyInlineHighlight` paints *everything capitalised* the
  same colour, so `Table` and a user's `BSolver2D` are indistinguishable — fine
  for a short output snippet, poor across a 138-cell notebook. It is still used
  for LaTeX.
- Running the extension's real TextMate grammar would need `vscode-textmate`
  plus an Oniguruma WASM build (~800 KB) to interpret regexes JS cannot.

The part of that grammar carrying the visual weight is its **builtin-symbol
list**, and that is plain data. `extract-builtins.mjs` pulls 4175 `System\``
names out of `wolfram.tmLanguage.json` into `extension/vendor/wl-builtins.js`, so builtins
are identified from the same source VS Code uses. Re-run it, like
`sync-assets.sh`, after upgrading the extension:

```bash
./sync-assets.sh          # stylesheets, KaTeX, the LaTeX highlighter
node extract-builtins.mjs # the Wolfram builtin list
```

(Its accuracy is checkable: `Eigensystem` is a builtin, `EigenSystem` is not.)

### Everything mounts in a shadow root

Not cosmetic — two concrete failures it prevents:

- `WL_CSS` contains bare `pre { … }` and `:root { … }` rules that would
  otherwise restyle Overleaf's own interface;
- Overleaf's stylesheet would otherwise reach into KaTeX markup, where one
  inherited `line-height` visibly breaks equations.

Two consequences worth knowing before editing `extension/viewer/`:

- **`@font-face` is split out to the document head.** Chrome ignores
  `@font-face` declared inside a shadow root, but fonts registered on the
  document are usable by shadow content.
- **`:root` is rewritten to `:host`.** `:root` matches the document element and
  never matches inside a shadow tree, so `WL_CSS`'s variable block silently
  defined nothing — fractions and superscripts lost their metrics.
  `checks/check-browser.mjs` now pins both directions: the variable must be
  readable inside the shadow root and absent outside it.

## Checks

```bash
node checks/run-all.mjs               # everything (browser suites skip without Chrome)
node checks/run-all.mjs --screenshot  # also writes fixtures/viewer.png

node checks/check-parse.mjs      # every module imports (see below)
node checks/check-zip.mjs        # zip reader vs a real zip built on the spot
node checks/check-md.mjs         # markdown subset
node checks/check-wl-highlight.mjs # the Wolfram tokenizer
node checks/check-browser.mjs    # the viewer in real Chrome: CSS scoping, KaTeX,
                                 # sanitising, output fidelity
node checks/check-standalone.mjs # the real standalone page, loaded as a page
node checks/check-extension.mjs  # real content.js against Overleaf's real markup
node checks/check-evaluate.mjs   # Run / Run all / Math toggle, against a fake kernel
node checks/check-diagnostics.mjs # the failure reporting, on an unmountable page
node fixtures/make-fixture.mjs   # rebuild the fixture from real notebooks
```

The fake Overleaf page in `check-extension.mjs` uses the **binary-file markup
copied from the live site**, so it exercises the real integration point.

## When it does not appear

The extension reports on itself. Open DevTools on the Overleaf tab and watch the
Console: while a `.wb` is open with no panel, it prints a report every 4 seconds
naming which probe failed, with a DOM outline on the first one.

```
__wolfbookDiagnose()           short report
__wolfbookDiagnose('full')     …plus a DOM outline of the relevant regions
__wolfbookDiagnose('download') save the whole report to a .txt file
```

These work in the console's **default `top` context** — `extension/page-bridge.js` exposes
them on the page's own window, because a content script's globals live in an
isolated world that would otherwise require switching the context dropdown. The
latest report is also kept in `chrome.storage.local` under `lastDiagnosis`.

`fixtures/sample.wb` is **assembled from real outputs harvested from notebooks in
this workspace**, not hand-authored, so the checks exercise the markup the
renderer genuinely emits. It also carries a deliberately hostile output
(`<script>`, `onerror`, `javascript:`, `<iframe>`) that the sanitiser must
neutralise, and an image that is deliberately absent from the project.

**Look at the screenshot, don't just read the assertions.** Several fidelity
bugs — markdown math left as raw LaTeX, raw HTML in markdown being escaped,
`~~~wolfram` blocks flattened into a paragraph — passed every assertion and were
obvious in the picture.

**`check-parse.mjs` is not redundant with `node --check`.** That parses only the
file you name, never the modules it imports. A stray backtick in a CSS comment
inside a template literal in `theme-css.js` broke the entire viewer in the
browser while every Node-side suite stayed green, because no unit test imported
that module. `check-parse.mjs` imports all of them, `extension/vendor/` included.

## Two things the offline checks cannot prove

1. **That the extension loads.** Chrome disabled `--load-extension` in M137
   (verified here on Chrome 151: a test extension never appears as a target), so
   `check-extension.mjs` runs the real `extension/content.js` as a page script behind a
   small `chrome` shim. The manifest, the isolated world, and dynamic `import()`
   of a web-accessible resource from a content script are therefore unverified.
   That last one is the standard MV3 pattern and is expected to work; if it does
   not, the panel shows an explicit error instead of staying blank.
2. **That Overleaf's DOM matches the probes.** The fixture page is built from
   the same selectors `extension/content.js` looks for, so it validates our code and never
   our guess about Overleaf's markup.

When Overleaf drifts, the entire fix is two functions in `extension/content.js`:
`probeSelectedFile()` and `probeEditorPane()`. Nothing else — not the zip
endpoint, the `.wb` format, or the MCP contract — depends on Overleaf's markup.

## Security

- Stored output HTML is authored by whoever ran the notebook, who in a shared
  project need not be the person reading it, so it is treated as untrusted:
  scripts, iframes, `on*` handlers and `javascript:` URLs are stripped; images
  become `blob:` URLs; `data-wl-img` (an absolute path on the author's machine)
  is dropped.
- Markdown cells go through the same sanitiser, because the `.nb` importer
  legitimately puts raw `<img>` tags in them.
- The local MCP server already answers any caller with `Access-Control-Allow-Origin: *`.
  This extension adds no new exposure, but the server should reject web-page
  origins — see the plan doc.
