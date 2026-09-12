# GIF Creator

Make GIFs, MP4s, and still frames from videos, with captions. Open a video or paste a link, trim and crop it, add text or subtitles, and export. Everything runs on your own computer: a small Python program uses ffmpeg to do the work, and the editor opens in your web browser.

Works on macOS and Windows.

- Trim on a filmstrip timeline and crop to any shape
- Write captions in any installed font, or import subtitles (.srt, .vtt, .ass, or subtitle tracks inside the video)
- Export a GIF, an MP4 with sound, an animated WebP, or a single PNG frame
- Download videos from YouTube and many other sites (uses yt-dlp)

## Install

GIF Creator needs three free tools: **Python** 3.9 or newer, **ffmpeg**, and **yt-dlp** (only needed for downloading from links). Then you download GIF Creator itself. There's nothing else to install.

### macOS

1. Install [Homebrew](https://brew.sh) if you don't already have it.
2. Open Terminal and run:

   ```bash
   brew install python ffmpeg yt-dlp
   ```

3. Download GIF Creator: at the top of this page, click **Code**, then **Download ZIP**. Double-click the ZIP to unzip it, and move the `gif-creator-main` folder somewhere you'll keep it, such as Documents.
4. Open that folder and double-click **GIF Creator.command**.

   The first time, macOS may say it can't verify the file. Close the message, open **System Settings**, go to **Privacy & Security**, scroll down, and click **Open Anyway** next to the note about GIF Creator.command. (On older versions of macOS, Control-click the file and choose **Open** instead.)

### Windows

1. Open **Terminal** (or PowerShell) and run these one at a time:

   ```powershell
   winget install Python.Python.3.13
   winget install Gyan.FFmpeg
   winget install yt-dlp.yt-dlp
   ```

   When they finish, close Terminal so the new tools are found the next time a window opens.
2. Download GIF Creator: at the top of this page, click **Code**, then **Download ZIP**. Right-click the ZIP, choose **Extract All**, and keep the extracted `gif-creator-main` folder somewhere permanent, such as Documents.
3. Open that folder and double-click **GIF Creator.bat**.

   If Windows warns that the file came from the internet, choose **Run** (or **More info**, then **Run anyway**).

### The first time it opens

A small window appears showing that GIF Creator is running. Keep it open while you work, and close it when you're done. Your browser opens GIF Creator and asks you to:

- **Pick a folder for your files.** It suggests `Movies/GIF Creator` on macOS and `Videos\GIF Creator` on Windows. Finished files go in an `Exports` folder inside it, and videos you download or drop in go in `Downloads`.
- **Choose which folders to list videos from**, such as Downloads and Desktop.

You can change both later with **Settings** in the top bar. To use GIF Creator again, double-click the launcher again.

### Updating

Download the ZIP again and replace the old folder (or run `git pull` if you cloned the repository). Your settings and files are stored outside that folder, so nothing is lost.

## Making a GIF

1. **Pick a video.** The library lists videos from the folders you chose. You can also paste a link into the top bar, click **Open file…**, or drop a video onto the window.
2. **Set the clip.** Drag the yellow handles on the filmstrip, or press <kbd>I</kbd> and <kbd>O</kbd> at the playhead. Scroll over the timeline to zoom.
3. **Crop** (optional). Drag the edges of the video, or pick a shape: 1:1, 4:5, 16:9, or 9:16.
4. **Add text.** Press <kbd>T</kbd>, type, and drag the text on the video to place it. Styles: Meme, Subtitle, Label, and Marker. Each line of text also appears as a bar in the **Text** row under the filmstrip: click one to jump to it and edit it, drag it to move it in time, or drag its ends to change how long it shows.
5. **Export.** Choose GIF, MP4, or WebP, plus a width and frame rate, then click **Export** (or press <kbd>⌘E</kbd> on macOS, <kbd>Ctrl+E</kbd> on Windows). MP4s include the video's sound unless you untick **Include sound**; speed and boomerang apply to the sound too. **Copy file** puts the finished file on your clipboard, ready to paste into a chat app or a folder.

Text is drawn by the browser and burned into the frames, so the preview matches the export exactly.

**Still frames:** pause on the frame you want (<kbd>←</kbd> and <kbd>→</kbd> step one frame), then click **Save frame** or press <kbd>F</kbd>. You get a full-resolution PNG of the cropped picture, including any text showing at that moment.

### Subtitles

- When downloading from a link, open **Options** and tick **Also save English subtitles**.
- For your own videos, an `.srt` or `.vtt` file with the same name next to the video is found automatically, as are subtitle tracks inside `.mkv` and `.mp4` files.
- For subtitles saved anywhere else, click **Import subtitles**, then **Choose file…**.
- **Import subtitles** adds the lines that fall inside your clip as captions you can edit. Repeated lines in YouTube's automatic captions and subtitle-site credit lines ("sync & correction by…") are skipped.
- If a subtitle file was timed for a different copy of the video, set **Shift timing**. A positive number of seconds makes lines appear later.

### Downloading part of a long video

Before downloading, open **Options** and set *Only download from … to …* (for example `12:30` to `13:05`) to fetch just that section.

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| Space | Play or pause (loops the clip) |
| I / O | Set the clip start / end at the playhead |
| ← / → | Step one frame (hold Shift for one second) |
| [ / ] | Jump to the clip start / end |
| T | Add text at the playhead |
| F | Save the frame on screen as a PNG |
| Delete | Remove the selected text |
| ⌘E (macOS) / Ctrl+E (Windows) | Export |

## Where things are saved

| What | macOS | Windows |
| --- | --- | --- |
| Exports and downloaded videos | The folder you picked | The folder you picked |
| Settings | `~/Library/Application Support/GIF Creator` | `%APPDATA%\GIF Creator` |
| Thumbnails and preview copies | `~/Library/Caches/GIF Creator` | `%LOCALAPPDATA%\GIF Creator\Cache` |

The thumbnails folder is safe to delete. Preview copies are made for video or sound your browser can't play, such as DTS or AC3 audio.

Only your computer can open GIF Creator: it listens on `127.0.0.1`, never on your network.

## Troubleshooting

- **"GIF Creator needs ffmpeg"**: install ffmpeg (see above), close the window, and start GIF Creator again. On Windows, a Terminal window that was already open won't see newly installed tools, so open a new one.
- **A link won't download**: sites change often, so update yt-dlp with `brew upgrade yt-dlp` (macOS) or `winget upgrade yt-dlp.yt-dlp` (Windows).
- **"Port 8765 is in use"**: start GIF Creator on another port. In the GIF Creator folder, run `python3 app/server.py --port 8766` (macOS) or `py app\server.py --port 8766` (Windows).
- **The launcher doesn't open**: run GIF Creator from a terminal instead. In the GIF Creator folder, run `python3 app/server.py` (macOS) or `py app\server.py` (Windows). Any error appears there.
