#!/bin/bash
# Make Chrome one of the apps that can open a .wb — WITHOUT taking the double-click.
#
#   tools/register-chrome-viewer-macos.sh              install (auto-detect the extension)
#   tools/register-chrome-viewer-macos.sh --extension-id abcd…   use a specific extension
#   tools/register-chrome-viewer-macos.sh --uninstall
#
# WHAT IT BUILDS
#   ~/Applications/Wolfbook Viewer (Chrome).app — a tiny stub that receives the
#   file from Finder and hands its path to this extension's viewer page:
#
#       chrome-extension://<id>/viewer/standalone.html?src=file:///…
#
#   Chrome itself cannot be given the type directly: its Info.plist is inside a
#   signed bundle, and editing it breaks the signature. A stub app is the
#   supported way to add an entry to Finder's "Open With" list.
#
# WHY IT DOES NOT BECOME THE DEFAULT
#   The declaration uses CFBundleTypeRole = Viewer and LSHandlerRank = Alternate,
#   and the script never calls LSSetDefaultRoleHandlerForContentType. So Finder
#   lists it under "Open With" while a double-click keeps going wherever it went
#   before — VS Code, if you ran register-filetypes-macos.sh in the workspace.
#
# ONE MANUAL STEP REMAINS: Chrome must be allowed to read local files.
#   chrome://extensions → this extension → "Allow access to file URLs".
#   The viewer page says so itself, with a button, if it is not granted. Without
#   it the page still opens — you just drop the file onto it instead.
set -euo pipefail

APP_NAME="Wolfbook Viewer (Chrome)"
APP="$HOME/Applications/$APP_NAME.app"
BUNDLE_ID="com.wolfbook.chromeviewer"
EXT_ID=""
UNINSTALL=0

while [ $# -gt 0 ]; do
  case "$1" in
    --extension-id) EXT_ID="${2:-}"; shift 2 ;;
    --uninstall)    UNINSTALL=1; shift ;;
    -h|--help)      sed -n '2,26p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister

if [ "$UNINSTALL" = 1 ]; then
  if [ -d "$APP" ]; then
    "$LSREGISTER" -u "$APP" >/dev/null 2>&1 || true
    rm -rf "$APP"
    echo "removed $APP"
  else
    echo "nothing to remove ($APP does not exist)"
  fi
  exit 0
fi

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
EXT_DIR="$REPO_DIR/extension"

# ── which extension? ────────────────────────────────────────────────────────
#
# An unpacked extension's id is derived from the FOLDER IT WAS LOADED FROM, so
# it differs per machine and cannot be hard-coded. Chrome records it in the
# profile, keyed by that path — which is exactly what we have.
if [ -z "$EXT_ID" ]; then
  EXT_ID="$(python3 - "$EXT_DIR" <<'PY' || true
import json, os, sys, glob
want = os.path.realpath(sys.argv[1])
# by_path is authoritative; by_name is the fallback for a packed install, where
# the recorded "path" is the Chrome extension store.
by_path, by_name = [], []
prefs = glob.glob(os.path.expanduser('~/Library/Application Support/Google/Chrome/*/Secure Preferences'))
prefs += glob.glob(os.path.expanduser('~/Library/Application Support/Google/Chrome/*/Preferences'))
for pref in prefs:
    try:
        settings = json.load(open(pref)).get('extensions', {}).get('settings', {})
    except Exception:
        continue
    for eid, v in settings.items():
        path = str(v.get('path', '') or '')
        name = ((v.get('manifest') or {}).get('name') or '')
        # An EMPTY path is not a match. realpath of an empty string is the CURRENT DIRECTORY,
        # which is this repo when the script is run from it — so without this
        # guard every extension that records no path matched, and the first one
        # alphabetically was baked into the app.
        if path and os.path.realpath(path) == want:
            if eid not in by_path:
                by_path.append(eid)
        elif name == 'Wolfbook for Overleaf':
            if eid not in by_name:
                by_name.append(eid)
hits = by_path or by_name
print(hits[0] if hits else '')
PY
)"
fi

if [ -z "$EXT_ID" ]; then
  cat >&2 <<MSG
Could not work out the extension id.

  Load the extension first (chrome://extensions → Developer mode → Load unpacked
  → $EXT_DIR), then run this again — or pass it yourself:

    $0 --extension-id <id from chrome://extensions>
MSG
  exit 1
fi

echo "extension : $EXT_ID"
echo "source    : $EXT_DIR"

# ── build the stub app ──────────────────────────────────────────────────────
#
# A plain shell script in an .app does NOT receive dropped files: Finder sends
# them as an Apple Event ('odoc'), not as argv. An AppleScript applet with an
# `on open` handler does, which is why this is compiled rather than copied.
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

cat > "$TMP/handler.applescript" <<'APPLESCRIPT'
on open theFiles
	repeat with f in theFiles
		set helper to POSIX path of (path to resource "open-in-chrome.sh")
		do shell script quoted form of helper & " " & quoted form of (POSIX path of f)
	end repeat
end open

on run
	display dialog "This app opens Wolfbook notebooks (.wb) in Google Chrome." & return & return & ¬
		"Use it from Finder: right-click a .wb file → Open With → Wolfbook Viewer (Chrome)." ¬
		buttons {"OK"} default button 1 with title "Wolfbook Viewer (Chrome)"
end run
APPLESCRIPT

rm -rf "$APP"
mkdir -p "$HOME/Applications"
osacompile -o "$APP" "$TMP/handler.applescript"

# The helper is a separate file so the URL-encoding lives in shell rather than
# being escaped three times through AppleScript. perl is used because it is
# always present on macOS and needs no module.
cat > "$APP/Contents/Resources/open-in-chrome.sh" <<HELPER
#!/bin/bash
set -euo pipefail
EXT_ID="$EXT_ID"
HELPER
cat >> "$APP/Contents/Resources/open-in-chrome.sh" <<'HELPER'
file="${1:-}"
[ -n "$file" ] || exit 0

# Percent-encode the path: a space or a "#" in a filename would otherwise
# truncate the URL, and Dropbox paths are full of both.
enc="$(/usr/bin/perl -e '
  my $p = $ARGV[0];
  $p =~ s/([^A-Za-z0-9\-_.~\/])/sprintf("%%%02X", ord($1))/ge;
  print $p;' "$file")"

url="chrome-extension://$EXT_ID/viewer/standalone.html?src=file://$enc"

if [ ! -d "/Applications/Google Chrome.app" ] && ! open -Ra "Google Chrome" 2>/dev/null; then
  osascript -e 'display alert "Google Chrome is not installed" message "The Wolfbook Chrome viewer opens notebooks in Chrome."' >/dev/null
  exit 1
fi
exec /usr/bin/open -a "Google Chrome" "$url"
HELPER
chmod +x "$APP/Contents/Resources/open-in-chrome.sh"

# ── declare the type, as an ALTERNATE handler ───────────────────────────────
PLIST="$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier $BUNDLE_ID" "$PLIST" >/dev/null 2>&1 \
  || /usr/libexec/PlistBuddy -c "Add :CFBundleIdentifier string $BUNDLE_ID" "$PLIST"
/usr/libexec/PlistBuddy -c "Delete :CFBundleDocumentTypes" "$PLIST" >/dev/null 2>&1 || true
/usr/libexec/PlistBuddy \
  -c "Add :CFBundleDocumentTypes array" \
  -c "Add :CFBundleDocumentTypes:0 dict" \
  -c "Add :CFBundleDocumentTypes:0:CFBundleTypeName string 'Wolfbook Notebook'" \
  -c "Add :CFBundleDocumentTypes:0:CFBundleTypeRole string Viewer" \
  -c "Add :CFBundleDocumentTypes:0:LSHandlerRank string Alternate" \
  -c "Add :CFBundleDocumentTypes:0:LSItemContentTypes array" \
  -c "Add :CFBundleDocumentTypes:0:LSItemContentTypes:0 string com.wolfbook.wb" \
  -c "Add :CFBundleDocumentTypes:0:CFBundleTypeExtensions array" \
  -c "Add :CFBundleDocumentTypes:0:CFBundleTypeExtensions:0 string wb" \
  -c "Add :CFBundleDocumentTypes:0:CFBundleTypeExtensions:1 string evsnb" \
  -c "Add :CFBundleDocumentTypes:0:CFBundleTypeExtensions:2 string vsnb" \
  "$PLIST" >/dev/null

# Ship the wolfbook icon so the entry is recognisable in the Open With menu.
if [ -f "$EXT_DIR/vendor/wolfbook-icon.png" ] && command -v sips >/dev/null; then
  ICONSET="$TMP/wb.iconset"; mkdir -p "$ICONSET"
  for s in 16 32 128 256 512; do
    sips -z $s $s "$EXT_DIR/vendor/wolfbook-icon.png" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null 2>&1 || true
  done
  if iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/applet.icns" 2>/dev/null; then :; fi
fi

# Touch the bundle so LaunchServices notices the new Info.plist, then register.
touch "$APP"
"$LSREGISTER" -f "$APP" >/dev/null 2>&1 || true

echo "installed : $APP"
echo
echo "Finder → right-click a .wb → Open With → $APP_NAME"
echo "(the double-click default is unchanged — this registers as an alternate handler)"
echo
echo "One switch is still needed for local files:"
echo "  chrome://extensions → Wolfbook for Overleaf → Allow access to file URLs"
