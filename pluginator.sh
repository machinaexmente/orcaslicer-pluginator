#!/usr/bin/env bash
# Starts Pluginator and opens it in its own window (Linux, macOS). --desktop-entry adds it to the app menu.
set -euo pipefail
cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"

if [[ "${1:-}" == "--desktop-entry" ]]; then
  apps="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
  mkdir -p "$apps"
  cat > "$apps/pluginator.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Pluginator
Comment=Browse and install OrcaSlicer plugins
Exec="$PWD/pluginator.sh"
Icon=$PWD/public/icon.svg
Terminal=false
Categories=Graphics;3DGraphics;
DESKTOP
  echo "Added $apps/pluginator.desktop"
  exit 0
fi

command -v node >/dev/null || { echo "Node.js 18+ is required: https://nodejs.org" >&2; exit 1; }
if [[ ! -d node_modules/yaml ]]; then
  echo "Installing dependencies..."
  npm install --no-audit --no-fund
fi
exec node server.js "$@"
