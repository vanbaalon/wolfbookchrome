<p align="center">
  <img src="docs/logo.png" alt="Wolfbook" width="96" height="96">
</p>

<h1 align="center">Wolfbook for Overleaf</h1>

<p align="center">
  Read, run and edit Wolfram notebooks (<code>.wb</code>) inside Overleaf —
  against the Wolfram kernel on your own machine.
</p>

<p align="center">
  <a href="docs/wolfbook-overleaf-demo.mp4"><strong>▶ Watch the video demonstration</strong></a>
</p>

---

## Repository layout

```text
WolfbookChromeExtension/
├── extension/   ← select this folder with Chrome's “Load unpacked”
├── server/      ← local Wolfram evaluation and MCP bridge
├── checks/      ← automated checks
├── docs/        ← documentation and demonstration media
└── README.md
```

Overleaf treats a `.wb` file as a binary blob: it shows **“Sorry, no preview is
available”** and offers a download button. This extension replaces that dead
pane with the notebook itself — formatted markdown, typeset mathematics,
syntax-highlighted code and the plots the author last produced.

If you also have Wolfram installed, every cell gets a **▶ Run** button, and the
results come back from your own kernel.

## Nothing leaves your computer

This is worth stating plainly, because the extension talks to a Wolfram kernel
and that sounds like it might involve a server somewhere. It does not.

- **There is no Wolfbook-operated cloud service, telemetry, or account.** The
  extension talks only to Overleaf and services on your own machine.
- The notebook is fetched **from Overleaf, by your own browser**, over the
  session you are already signed into — the same request Overleaf's own
  Download button makes.
- Evaluation runs on **`127.0.0.1`**, on the machine you are sitting at, against
  the Wolfram kernel you installed. Your code and results never traverse the
  network. Locally opened notebooks still work offline; loading from or saving
  to Overleaf naturally requires an internet connection.
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

## Installation

### 1. Download the repository

Clone it:

```bash
git clone https://github.com/vanbaalon/wolfbookchrome.git
cd wolfbookchrome
```

Alternatively, download and extract GitHub's ZIP. In the instructions below,
the **repository root** means the extracted folder containing `README.md`,
`extension/`, and `server/`; its actual folder name does not matter.

### 2. Load the Chrome extension

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Click **Load unpacked**.
4. Select the repository's **`extension/` folder** — the folder containing
   `manifest.json`. Do not select the repository root or `server/`.
5. Reload any Overleaf project tabs that were already open.

There is no build or `npm install` step. Everything Chrome needs is committed
inside `extension/`.

When updating an existing checkout, pull the changes, click **Reload** on the
extension's card in `chrome://extensions`, and then reload the Overleaf tab. If
an older installation selected the repository root, remove that entry and use
**Load unpacked** again with `extension/`.

### 3. View, edit, and save a notebook

Open an Overleaf project containing a `.wb` file and click its file tab. The
notebook replaces Overleaf's normal editor pane while Overleaf's file tabs stay
visible. Viewing, editing cells, and pressing **Save to Overleaf** do not require
the local server.

To open a `.wb` from your computer instead, click the **Wolfbook icon** in
Chrome's toolbar and choose **Open a notebook…**.

> If a notebook refers to external image files, upload its
> `img/<notebook-name>/` folder to the Overleaf project too. Missing files are
> shown as placeholders. Newly evaluated plots are embedded in the saved
> notebook and do not need a separate sidecar folder.

### 4. Enable local Wolfram evaluation (optional)

Running cells requires:

- Node.js 18 or newer;
- Wolfram Mathematica or Wolfram Engine; and
- the [Wolfbook VS Code extension](https://github.com/vanbaalon/wolfbook)
  installed in VS Code.

VS Code does not need to be open merely to evaluate cells: `wolfbook-serve`
loads the installed Wolfbook runtime and native addons directly.

In Terminal, change to the **repository root**, not `extension/` or `server/`:

```bash
cd /path/to/wolfbookchrome
node server/cli.mjs start
node server/cli.mjs status
```

`start` launches the server in the background for the current login session.
On macOS or Linux, have the operating system start and supervise it
automatically instead by using this as an alternative to `start`:

```bash
node server/cli.mjs enable
```

`enable` records the repository's current absolute path in the operating-system
service definition. If you move the checkout later, run `enable` again from its
new repository root.

The first time you press **▶ Run**, paste the token printed by `start` or
`enable`. To print it again, run this from the repository root:

```bash
node server/cli.mjs token
```

The token is required because the server can evaluate arbitrary Wolfram code.
It is stored by the extension after the first successful connection. The
toolbar popup should now show **Local server running** in green.

### 5. Enable AI/MCP notebook access (optional)

Agent access additionally requires the main Wolfbook MCP server, normally
provided by an open VS Code window running the Wolfbook extension and configured
for your MCP client. Keep the desired `.wb` tab open in Overleaf. The popup's
MCP line names notebooks whose live browser editors answer the bridge check.

MCP agents can read, insert, edit, move, and run cells, but their changes remain
unsaved in the browser. Only the person using Overleaf can press **Save to
Overleaf**.

The toolbar popup also shows the exact versions of `wolfbook-serve`, Wolfbook,
WSTP, and BTL currently in use. If the local server is stopped, notebooks still
open and can be edited, but cells cannot be evaluated locally and MCP access is
unavailable.

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
