# GIF Creator

Make GIFs (or MP4 / WebP loops) from videos on your Mac, with captions. It runs locally: a small Python server drives `ffmpeg` and `yt-dlp`, and the editor opens in your browser.

## Start it

Double-click **GIF Creator.command**, or run:

```bash
python3 app/server.py
```

It opens http://127.0.0.1:8765. Only this Mac can reach the server.

Requirements: Python 3.9+, `ffmpeg`, and `yt-dlp` (`brew install ffmpeg yt-dlp`). No Python packages needed.

## Making a GIF

1. **Pick a video.** The library lists videos in `media/`, `~/Downloads`, `~/Movies`, and `~/Desktop`. You can also paste a link into the top bar, use **Open file…**, or drop a file on the window.
2. **Set the clip.** Drag the yellow grips on the filmstrip, or press <kbd>I</kbd> and <kbd>O</kbd> at the playhead. Scroll over the timeline to zoom.
3. **Crop** (optional). Drag the edges of the video, or pick a shape (1:1, 4:5, 16:9, 9:16).
4. **Add text.** Press <kbd>T</kbd>, type, and drag the text on the video to place it. Each line of text also appears as a bar in the **Text** row under the filmstrip: click one to jump to it and edit it, drag it to move it in time, or drag its ends to change how long it shows. Styles: Meme, Subtitle, Label, Marker.
5. **Export.** Choose GIF, MP4, or WebP, plus width and frame rate, then press <kbd>⌘E</kbd>. MP4s include the video's sound (untick **Include sound** to leave it out); speed and boomerang apply to the sound too. Files land in `exports/`. **Copy file** puts the file on your clipboard so you can paste it into Slack, Messages, or Finder.

Text is drawn by the browser and burned into the frames, so the preview matches the export exactly. Any installed font and emoji work.

**Still frames:** pause on the frame you want (<kbd>←</kbd> and <kbd>→</kbd> step one frame), then click **Save frame** or press <kbd>F</kbd>. You get a full-resolution PNG of the cropped picture, including any text showing at that moment, in `exports/`.

### Subtitles

- When downloading, open **Options** and tick **Also save English subtitles**.
- For your own files, put an `.srt` or `.vtt` with the same name next to the video. Text subtitle tracks inside `.mkv` / `.mp4` files are also found.
- Subtitles saved anywhere else (say, downloaded to `~/Downloads`): click **Import subtitles**, then **Choose file…**. The file stays in the list afterwards.
- In the Text panel, **Import subtitles** adds the lines that fall inside your clip as editable captions. YouTube's auto-captions are cleaned of their repeated lines, and subtitle-site credit lines ("sync & correction by…") are skipped.
- If a subtitle file was timed for a different release, set **Shift timing**: a positive number of seconds makes the lines appear later.

### Downloading part of a long video

In **Options**, set *Only download from … to …* (for example `12:30` to `13:05`) so only that section is fetched.

## Keyboard

| Key | Action |
| --- | --- |
| Space | Play or pause (loops the clip) |
| I / O | Set clip start / end at the playhead |
| ← / → | Step one frame (Shift: one second) |
| [ / ] | Jump to clip start / end |
| T | Add text at the playhead |
| F | Save the frame on screen as a PNG |
| Delete | Remove the selected text |
| ⌘E | Export |

## Settings

Create `config.json` next to this README to change the port or library folders:

```json
{
  "port": 8765,
  "library_dirs": ["~/Downloads", "~/Movies", "~/Desktop", "~/Dropbox/Clips"]
}
```

## Where things go

- `media/`: downloads and dropped files
- `exports/`: finished GIFs, MP4s, and WebPs
- `.cache/`: thumbnails, plus preview copies of video or sound the browser can't play (for example DTS or AC3 audio from Plex or Blu-ray rips). Safe to delete.

Your in-progress edits (clip range, crop, captions) are remembered per video in the browser.
