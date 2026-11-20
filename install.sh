#!/usr/bin/env bash
# automm-ui installer. Run it ON THE PRINTER, as the user that owns Klipper,
# Moonraker and the web interface (on a QIDI Q2 that is `qidi`, not `mks`).
#
#   ./install.sh                 install, or update an existing install
#   ./install.sh --uninstall     remove everything this script added
#   ./install.sh --dry-run       show what would happen, change nothing
#   ./install.sh --no-sidebar    don't add the "Calibration" entry to Fluidd's sidebar
#   ./install.sh --camera        also add the page as a card on Fluidd's dashboard (Cameras)
#   ./install.sh --help
#
# It never needs sudo and never touches Klipper, printer.cfg or Automm3AdaptivePA.
# What it does (all undone by --uninstall):
#   1. links web/data            -> ~/printer_data/qidi_pa   (Automm3AdaptivePA's results)
#   2. links <web root>/automm   -> web/                     (serves the page at /automm/)
#   3. Fluidd only: adds one <script> tag to Fluidd's index.html for the sidebar entry,
#      after saving the untouched original to backup/
#   4. --camera only: registers the page with Moonraker as an "HTTP page" camera
#
# Paths can be overridden for unusual setups (and for the tests):
#   PRINTER_DATA, RESULTS_DIR, WEB_ROOT, NGINX_SITES, MOONRAKER_URL

set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEB_DIR="$APP_DIR/web"
BACKUP_DIR="$APP_DIR/backup"
VERSION="$(cat "$APP_DIR/VERSION" 2>/dev/null || echo "?")"

PRINTER_DATA="${PRINTER_DATA:-$HOME/printer_data}"
RESULTS_DIR="${RESULTS_DIR:-$PRINTER_DATA/qidi_pa}"
NGINX_SITES="${NGINX_SITES:-/etc/nginx/sites-enabled}"
WEB_ROOT="${WEB_ROOT:-}"
MOONRAKER_URL="${MOONRAKER_URL:-http://127.0.0.1:7125}"

LINK_NAME="automm"                                   # the page is served at /automm/
NAV_TAG='<script src="./automm/fluidd-nav.js" defer></script>'
CAMERA_NAME="Calibration"

MODE="install"; DRY=0; SIDEBAR=1; CAMERA=0

usage() { sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

for arg in "$@"; do
  case "$arg" in
    --uninstall)  MODE="uninstall" ;;
    --dry-run)    DRY=1 ;;
    --no-sidebar) SIDEBAR=0 ;;
    --camera)     CAMERA=1 ;;
    -h|--help)    usage; exit 0 ;;
    *) echo "unknown option: $arg (see --help)" >&2; exit 2 ;;
  esac
done

say()  { printf '%s\n' "$*"; }
ok()   { printf '  ok   %s\n' "$*"; }
skip() { printf '  --   %s\n' "$*"; }
warn() { printf '  !!   %s\n' "$*" >&2; }
die()  { printf '\nERROR: %s\n' "$*" >&2; exit 1; }
# run a command, or only describe it on a dry run
act()  { if [ "$DRY" = 1 ]; then printf '  dry  %s\n' "$*"; else "$@"; fi; }

# ---------------------------------------------------------------- where is the web interface?
# Ask nginx: the site that proxies Moonraker's websocket is the one serving Fluidd/Mainsail.
find_web_root() {
  [ -n "$WEB_ROOT" ] && { readlink -f "$WEB_ROOT"; return; }
  local site root
  for site in "$NGINX_SITES"/*; do
    [ -f "$site" ] || continue
    grep -q 'location /websocket' "$site" 2>/dev/null || continue
    root="$(sed -n 's/^[[:space:]]*root[[:space:]]\{1,\}\([^;]*\);.*/\1/p' "$site" | head -n 1)"
    [ -n "$root" ] && [ -d "$root" ] && { readlink -f "$root"; return; }
  done
  for root in "$HOME/fluidd" "$HOME/mainsail"; do
    [ -d "$root" ] && { readlink -f "$root"; return; }
  done
  return 1
}

# fluidd | mainsail | unknown
ui_kind() {
  local info="$1/release_info.json"
  if [ -f "$info" ] && grep -qi '"project_name" *: *"fluidd"' "$info"; then echo fluidd
  elif [ -f "$info" ] && grep -qi '"project_name" *: *"mainsail"' "$info"; then echo mainsail
  elif grep -qi 'fluidd' "$1/index.html" 2>/dev/null; then echo fluidd
  else echo unknown; fi
}

# ln -sfn, but refuse to replace something that isn't already a symlink
link() {
  local target="$1" path="$2"
  if [ -e "$path" ] && [ ! -L "$path" ]; then
    die "$path already exists and is not a link. Move it out of the way, then run this again."
  fi
  act ln -sfn "$target" "$path"
}

has_nav_tag() { grep -qF 'automm/fluidd-nav.js' "$1"; }

add_nav_tag() {
  local index="$1"
  if has_nav_tag "$index"; then skip "sidebar entry already in $index"; return; fi
  grep -q '</head>' "$index" || die "$index has no </head>; can't add the sidebar entry (try --no-sidebar)."
  if [ ! -f "$BACKUP_DIR/fluidd-index.html.orig" ]; then
    act mkdir -p "$BACKUP_DIR"
    act cp "$index" "$BACKUP_DIR/fluidd-index.html.orig"
  fi
  act sed -i "s#</head>#$NAV_TAG</head>#" "$index"
  ok "sidebar entry added to $index"
}

remove_nav_tag() {
  local index="$1"
  if [ ! -f "$index" ] || ! has_nav_tag "$index"; then skip "no sidebar entry in Fluidd"; return; fi
  act sed -i 's#<script src="\./automm/fluidd-nav\.js" defer></script>##' "$index"
  ok "sidebar entry removed from $index"
}

moonraker() {   # method path [json]
  command -v curl >/dev/null || { warn "curl not found; skipping the Moonraker call"; return 1; }
  if [ "$DRY" = 1 ]; then printf '  dry  curl -X %s %s%s\n' "$1" "$MOONRAKER_URL" "$2"; return 0; fi
  if [ -n "${3:-}" ]; then
    curl -fsS --max-time 10 -X "$1" -H 'Content-Type: application/json' -d "$3" "$MOONRAKER_URL$2" >/dev/null
  else
    curl -fsS --max-time 10 -X "$1" "$MOONRAKER_URL$2" >/dev/null
  fi
}

# ---------------------------------------------------------------- install
install() {
  say "automm-ui $VERSION - installing from $APP_DIR"
  [ "$DRY" = 1 ] && say "(dry run: nothing will be changed)"
  [ -f "$WEB_DIR/index.html" ] || die "web/index.html is missing. Run this from the automm-ui folder."
  [ "$(id -u)" = 0 ] && die "don't run this as root or with sudo; run it as the user that owns Klipper (on a QIDI Q2: qidi)."

  local root kind
  root="$(find_web_root)" || die "couldn't find Fluidd or Mainsail. Set WEB_ROOT=/path/to/fluidd and run again."
  kind="$(ui_kind "$root")"
  [ -w "$root" ] || die "$root isn't writable by $(id -un). Log in as the user that owns it (on a QIDI Q2: qidi)."
  say "  web interface: $root ($kind)"

  if [ -d "$RESULTS_DIR" ]; then ok "Automm3AdaptivePA results found in $RESULTS_DIR"
  else warn "$RESULTS_DIR doesn't exist yet. Install and run Automm3AdaptivePA; the page fills in after its first calibration."; fi

  link "$RESULTS_DIR" "$WEB_DIR/data";    ok "web/data -> $RESULTS_DIR"
  link "$WEB_DIR" "$root/$LINK_NAME";      ok "$root/$LINK_NAME -> $WEB_DIR"

  if [ "$SIDEBAR" = 1 ] && [ "$kind" = fluidd ]; then add_nav_tag "$root/index.html"
  elif [ "$SIDEBAR" = 1 ]; then skip "sidebar entry: only available in Fluidd (open /automm/ directly instead)"
  else skip "sidebar entry: skipped (--no-sidebar)"; fi

  if [ "$CAMERA" = 1 ]; then
    if moonraker POST /server/webcams/item "{\"name\":\"$CAMERA_NAME\",\"service\":\"iframe\",\"stream_url\":\"/$LINK_NAME/?embed=1\",\"snapshot_url\":\"\",\"aspect_ratio\":\"1:1\",\"enabled\":true,\"location\":\"printer\",\"icon\":\"mdiWebcam\",\"target_fps\":15,\"target_fps_idle\":5,\"flip_horizontal\":false,\"flip_vertical\":false,\"rotation\":0}"
    then ok "dashboard card \"$CAMERA_NAME\" added (Fluidd: Cameras)"
    else warn "couldn't reach Moonraker at $MOONRAKER_URL to add the dashboard card"; fi
  fi

  # only to print a clickable address; not every `hostname` knows -I
  local ip; ip="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
  say ""
  say "Done. Open http://${ip:-<printer-ip>}/$LINK_NAME/"
  [ "$SIDEBAR" = 1 ] && [ "$kind" = fluidd ] && say "or reload Fluidd and click \"Calibration\" in the sidebar."
  return 0
}

# ---------------------------------------------------------------- uninstall
uninstall() {
  say "automm-ui $VERSION - uninstalling"
  [ "$DRY" = 1 ] && say "(dry run: nothing will be changed)"
  local root
  if root="$(find_web_root)"; then
    remove_nav_tag "$root/index.html"
    if [ -L "$root/$LINK_NAME" ]; then act rm "$root/$LINK_NAME"; ok "removed $root/$LINK_NAME"
    else skip "no $root/$LINK_NAME link"; fi
  else
    skip "couldn't find Fluidd or Mainsail; nothing to remove there"
  fi
  if [ -L "$WEB_DIR/data" ]; then act rm "$WEB_DIR/data"; ok "removed web/data link"; fi
  moonraker DELETE "/server/webcams/item?name=$CAMERA_NAME" 2>/dev/null && ok "removed dashboard card (if there was one)" || true
  say ""
  say "Done. Your calibration results were not touched."
  say "Filament names and colours stay in Moonraker's database (namespace \"automm_ui\");"
  say "use \"Delete all\" on the page before uninstalling if you want those gone too."
  say "You can now delete this folder: rm -rf \"$APP_DIR\""
}

if [ "$MODE" = uninstall ]; then uninstall; else install; fi
