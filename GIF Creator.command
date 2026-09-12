#!/bin/zsh
# Double-click to start GIF Creator in your browser.
# Keep this window open while you work. Close it (or press Ctrl+C) to stop GIF Creator.
cd "$(dirname "$0")"
export PATH="/opt/homebrew/bin:/usr/local/bin:/opt/homebrew/opt/ffmpeg-full/bin:$PATH"

if ! command -v python3 >/dev/null 2>&1; then
  echo "GIF Creator needs Python 3. Install it with:  brew install python"
  read -k 1 "?Press any key to close this window."
  exit 1
fi

python3 app/server.py "$@" || read -k 1 "?GIF Creator stopped because of the problem above. Press any key to close this window."
