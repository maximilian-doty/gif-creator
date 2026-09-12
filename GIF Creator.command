#!/bin/zsh
# Double-click to start GIF Creator in your browser.
# Leave this window open while you work; close it (or press Ctrl+C) to stop.
cd "$(dirname "$0")"
export PATH="/opt/homebrew/opt/ffmpeg-full/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
exec python3 app/server.py "$@"
