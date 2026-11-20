#!/usr/bin/env bash
# Install (or update) automm-ui on a printer from your computer, over SSH.
#
#   ./install-from-pc.sh <printer-ip>                    log in as "qidi" (QIDI Q2 default)
#   ./install-from-pc.sh <printer-ip> --user pi          another login
#   ./install-from-pc.sh <printer-ip> --uninstall        any install.sh option is passed on
#
# It copies this folder to ~/automm-ui on the printer and runs install.sh there.
# You type the printer's SSH password once (QIDI's default for "qidi" is "qiditech").
# Works on Linux and macOS, and on Windows from Git Bash or WSL.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST="${1:-}"
[ -n "$HOST" ] && [ "${HOST#-}" = "$HOST" ] || { sed -n '2,10p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 2; }
shift
SSH_USER="qidi"; PORT=22; PASS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --user) SSH_USER="${2:?--user needs a name}"; shift 2 ;;
    --port) PORT="${2:?--port needs a number}"; shift 2 ;;
    *) PASS+=("$1"); shift ;;
  esac
done

# what goes to the printer: the installer, the page and the paperwork; never the local web/data link
FILES=(install.sh VERSION LICENSE README.md web)
for f in "${FILES[@]}"; do [ -e "$HERE/$f" ] || { echo "missing $f - run this from the automm-ui folder" >&2; exit 1; }; done

ARGS=""
for a in ${PASS[@]+"${PASS[@]}"}; do ARGS+=" $(printf '%q' "$a")"; done

echo "Copying automm-ui to $SSH_USER@$HOST:~/automm-ui and running the installer..."
tar czf - -C "$HERE" --exclude='web/data' --exclude='.claude' "${FILES[@]}" |
  ssh -p "$PORT" -o StrictHostKeyChecking=accept-new "$SSH_USER@$HOST" \
    "mkdir -p ~/automm-ui && tar xzf - -C ~/automm-ui && bash ~/automm-ui/install.sh$ARGS"
