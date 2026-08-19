#!/bin/bash
# Copies the stylesheets the wolfbook VS Code renderer itself uses into extension/vendor/.
#
# WHY: a .wb output is stored HTML that was produced BY that renderer — mostly
# pre-rendered KaTeX (mord/pstrut/vlist spans) plus wolfbook's own custom
# elements (wrow/wfrac/wsub/…). Rendering it with a hand-written stylesheet
# means maintaining a second copy that silently drifts from the real one.
# So we vendor the extension's own CSS instead. Re-run after upgrading the
# extension.
#
# katex-css.js is ~370 KB because every woff2 font is inlined as a data: URI —
# that is exactly what we want here: no CDN, no network, works offline, and no
# layout jump while fonts load.
set -euo pipefail
cd "$(dirname "$0")"
VENDOR="extension/vendor"
ICONS="extension/icons"

CLIENT="../../../Extension Development/out/client"
if [ ! -d "$CLIENT" ]; then
  echo "error: extension client dir not found at $CLIENT" >&2
  echo "       (run this from the extension workspace)" >&2
  exit 1
fi

# katex.mjs is needed for MARKDOWN cells only. Stored code-cell outputs arrive
# pre-rendered (the kernel already typeset them), but a markup cell's $…$ is
# just source text, and physics notebooks are full of it.
mkdir -p "$VENDOR"
# renderer-highlight.js is the extension's own Wolfram/LaTeX highlighter; it
# emits the wl-hl-* classes WL_CSS already styles, so code cells look the way
# they do in the notebook editor.
for f in katex-css.js renderer-css.js katex.mjs renderer-highlight.js; do
  cp "$CLIENT/$f" "$VENDOR/$f"
  printf '  %-18s %8d bytes\n' "$f" "$(wc -c < "$VENDOR/$f")"
done

# renderer-css.js kills console.log at import time (it is written for the
# sandboxed VS Code webview). We import it for WL_CSS only, and we want our own
# diagnostics to survive, so neutralise that one line in the vendored copy.
python3 - <<'PY'
import re, pathlib
p = pathlib.Path('extension/vendor/renderer-css.js')
src = p.read_text()
patched = src.replace(
    "if (!DEV_MODE) { const _noop = () => {}; console.log = _noop; console.warn = _noop; }",
    "// [vendored for the Overleaf viewer] console-silencing removed: this module\n"
    "// is imported purely for WL_CSS, and the browser console is our debug surface.")
if patched == src:
    print('  note: console-silencing line not found (upstream changed?) — left as is')
p.write_text(patched)
PY

# The toolbar logo. icons/wolfbook_file_icon.png, NOT images/icon.png: only the
# file icon has an alpha channel, and a logo with a baked-in white square looks
# pasted onto the toolbar. Downscaled because the panel draws it at 16px.
for _logo in "$CLIENT/../icons/wolfbook_file_icon.png" "$CLIENT/../images/icon.png"; do
  if [ -f "$_logo" ]; then
    sips -Z 48 "$_logo" --out "$VENDOR/wolfbook-icon.png" >/dev/null 2>&1 \
      && printf '  %-18s %8d bytes  (%s)\n' "wolfbook-icon.png" \
           "$(wc -c < "$VENDOR/wolfbook-icon.png")" "$(basename "$_logo")"
    break
  fi
done

# Toolbar / extension icons, from the same alpha-channel source. Chrome shows
# these in the toolbar, the extensions page and the popup title bar; without
# them it draws a grey letter tile.
_src="$CLIENT/../icons/wolfbook_file_icon.png"
if [ -f "$_src" ]; then
  mkdir -p "$ICONS"
  for s in 16 32 48 128; do
    sips -Z $s "$_src" --out "$ICONS/icon${s}.png" >/dev/null 2>&1 \
      && printf '  %-18s %8d bytes\n' "extension/icons/icon${s}.png" "$(wc -c < "$ICONS/icon${s}.png")"
  done
fi

echo "vendored ok"
