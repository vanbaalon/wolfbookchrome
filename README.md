<p align="center">
  <img src="docs/logo.png" alt="Wolfbook" width="96" height="96">
</p>

<h1 align="center">Wolfbook for Overleaf</h1>

<p align="center">
  Read, run and edit Wolfram notebooks (<code>.wb</code>) inside Overleaf —
  against the Wolfram kernel on your own machine.
</p>

---

Overleaf treats a `.wb` file as a binary blob: it shows **“Sorry, no preview is
available”** and offers a download button. This extension replaces that dead
pane with the notebook itself — formatted markdown, typeset mathematics,
syntax-highlighted code and the plots the author last produced.

If you also have Wolfram installed, every cell gets a **▶ Run** button, and the
results come back from your own kernel.

## Nothing leaves your computer

This is worth stating plainly, because the extension talks to a Wolfram kernel
and that sounds like it might involve a server somewhere. It does not.

- **There is no cloud service, no telemetry, and no account.** The extension
  sends nothing anywhere, and there is nothing to sign up for.
- The notebook is fetched **from Overleaf, by your own browser**, over the
  session you are already signed into — the same request Overleaf's own
  Download button makes.
- Evaluation runs on **`127.0.0.1`**, on the machine you are sitting at, against
  the Wolfram kernel you installed. Your code and results never traverse the
  network. If your machine is offline, everything except loading the file from
  Overleaf still works.
- Nothing is written back to Overleaf unless **you** press **Save**.

The only outbound traffic is to `overleaf.com`, the site you already have open.

## What it does

| | |
|---|---|
| **View** | `.wb` notebooks render in place of Overleaf's “no preview” pane: markdown with KaTeX, Wolfram syntax highlighting that tells builtins from your own symbols, stored plots, tables and errors. |
| **Run** | With a local Wolfram kernel, each cell gets **▶ Run**; results are the kernel's own output — real SVG plots, typeset mathematics, untruncated. |
| **Edit** | Click any cell to edit it in CodeMirror. Insert, delete, move and re-type cells; ⌘Z undoes. |
| **Save** | One button writes the notebook back to your Overleaf project, with a check that nobody changed it meanwhile. |
| **Copy LaTeX** | Every equation offers its LaTeX source — you are in Overleaf, after all. |
| **Standalone** | A `.wb` that is not in Overleaf at all — in `~/Downloads`, or attached to an email — opens in its own tab. Same renderer, same optional kernel. |
| **AI access** | Optionally, agents speaking MCP can read, run and edit the open notebook. Saving is never theirs to do. |

## Install

1. **Download or clone this repository.**
2. Chrome → `chrome://extensions` → turn on **Developer mode** →
   **Load unpacked** → choose this folder.
3. Open an Overleaf project containing a `.wb` file and click it — or click the
   **Wolfbook icon** in the toolbar to open a `.wb` from your own computer.

That is all that is needed for viewing. There is no build step: everything the
browser needs is committed.

The toolbar popup reports whether the local server is running and shows the
versions of `wolfbook-serve`, Wolfbook, WSTP and BTL that are actually in use.
If the server is stopped, the same popup gives the exact start and enable-at-login
commands; notebooks remain available read-only.

> Upload the notebook's `img/<notebook-name>/` folder to your Overleaf project
> as well, or plots will show as “not in this Overleaf project” placeholders —
> Overleaf has no way to know those files belong to the notebook.

### To run and edit cells

You need the **Wolfbook VS Code extension installed** — though it does not have
to be running, and no window has to be open. The local server borrows its
Wolfram integration:

```bash
cd server
node cli.mjs start      # prints a URL and a token
node cli.mjs enable     # optional: start it at login
node cli.mjs token      # print the token again
```

The first time you press ▶, the panel asks for that token once and remembers it.
It is not optional: every request to the server evaluates arbitrary Wolfram
code, so a web page that merely guesses the port must not get through.

Requirements: **Node 18+**, **Wolfram Mathematica or Wolfram Engine**, and the
Wolfbook VS Code extension.

## This is not the main Wolfbook

For notebooks on your own machine, use the real thing:

### 👉 [github.com/vanbaalon/wolfbook](https://github.com/vanbaalon/wolfbook)

That is the Wolfbook VS Code extension — the full notebook editor, debugger,
interactive 3D graphics, `Manipulate`, presentations and AI tooling. This
repository is a companion for one specific situation: a notebook that lives in
an Overleaf project, next to the paper it belongs to.

This extension **reuses** that one wherever it can — the same stylesheets, the
same KaTeX, the same Wolfram symbol table, the same rendering pipeline — so a
notebook looks the same in Overleaf as it does in VS Code, rather than
approximately the same.

## Opening a `.wb` that is not in Overleaf

A notebook you were sent, or one sitting in `~/Downloads`, can be opened in a
Chrome tab of its own — rendered by the same viewer, with the same optional
kernel behind it:

- Click the **Wolfbook icon** in Chrome's toolbar → **Open a notebook…**, then
  pick the file or drop it onto the page. Neither needs any permission.
- Or let Chrome read local files directly, which is what makes the Finder route
  below work: `chrome://extensions` → this extension → **Allow access to file
  URLs**. The page says so itself, with a button, if it is missing.

Edits made there are kept with **Download .wb** — a browser tab has no authority
to rewrite the file it was opened from, and quietly overwriting a file you
double-clicked would be the wrong default even if it had.

### Adding Chrome to Finder's "Open With" menu (macOS)

```bash
tools/register-chrome-viewer-macos.sh
```

This builds `~/Applications/Wolfbook Viewer (Chrome).app`, a stub that hands the
file's path to the viewer page. It registers as an **alternate** handler
(`LSHandlerRank: Alternate`), so Chrome joins the **Open With** list and your
double-click default is left exactly as it was. `--uninstall` removes it.

Chrome cannot be given the type directly: its `Info.plist` lives inside a signed
bundle, and editing it breaks the signature. A stub app is the supported way to
add an entry to that menu.

### What a double-click should do

macOS does not know what a `.wb` file is, so it gives the file a *dynamic* type
that no application claims. To point double-click at the real editor:
right-click a `.wb` in Finder → **Get Info** → **Open with** → *Visual Studio
Code* → **Change All…**

## Documentation

- [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) — how it works, the design
  decisions behind it, and the test suite.
- [`server/README.md`](server/README.md) — the local server: what it does, why
  it exists, and how it joins the MCP coalition.

## Licence

Apache 2.0, matching the main Wolfbook extension. Vendored third-party assets
(KaTeX, CodeMirror) keep their own licences.
