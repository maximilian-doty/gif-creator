"""Native helpers: file and folder pickers, showing files in Finder/File Explorer, and the clipboard.

macOS uses AppleScript, Windows uses Windows PowerShell. On Linux, pickers need zenity.
"""

import base64
import os
import shutil
import subprocess
import sys
from pathlib import Path

IS_MAC = sys.platform == "darwin"
IS_WINDOWS = os.name == "nt"

VIDEO_PATTERNS = "*.mp4;*.mov;*.m4v;*.mkv;*.webm;*.avi;*.flv;*.wmv;*.mpg;*.mpeg;*.ts;*.m2ts;*.mts;*.3gp;*.ogv"
SUBTITLE_PATTERNS = "*.srt;*.vtt;*.ass;*.ssa"


class Unsupported(Exception):
    """This computer has no way to do that; the message tells the person what to do instead."""


def _existing_folder(path):
    p = Path(path).expanduser() if path else Path.home()
    while not p.is_dir() and p != p.parent:
        p = p.parent
    return str(p if p.is_dir() else Path.home())


# ---------------------------------------------------------------- Windows

def _powershell(script, **env):
    # -EncodedCommand avoids quoting problems; values arrive through environment variables, never the script text.
    code = "[Console]::OutputEncoding = [Text.Encoding]::UTF8\n" + script
    return subprocess.run(
        ["powershell", "-NoProfile", "-STA", "-EncodedCommand", base64.b64encode(code.encode("utf-16-le")).decode()],
        capture_output=True, text=True, encoding="utf-8", env={**os.environ, **env},
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))


_WIN_OWNER = ("Add-Type -AssemblyName System.Windows.Forms\n"
              "$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false }\n")


def _windows_result(r):
    if r.returncode != 0:
        lines = r.stderr.strip().splitlines()
        raise RuntimeError(lines[-1] if lines else "The file picker couldn't open")
    return r.stdout.strip() or None


# ---------------------------------------------------------------- macOS

def _osascript(lines, *args):
    cmd = ["osascript"]
    for line in ["on run argv", *lines, "end run"]:
        cmd += ["-e", line]
    r = subprocess.run(cmd + list(args), capture_output=True, text=True)
    if r.returncode != 0:
        if "-128" in r.stderr:  # the person clicked Cancel
            return None
        raise RuntimeError(r.stderr.strip() or "AppleScript failed")
    return r.stdout.strip() or None


# ---------------------------------------------------------------- public helpers

def choose_file(kind, start=None):
    """Ask for a video ("video") or subtitle file ("subtitle"). Returns a path, or None if canceled."""
    title = "Choose a video to make a GIF from" if kind == "video" else "Choose a subtitle file (.srt, .vtt, .ass)"
    start = _existing_folder(start or Path.home() / "Downloads")
    if IS_MAC:
        types = ' of type {"public.movie", "public.mpeg-4", "org.matroska.mkv", "org.webmproject.webm"}' if kind == "video" else ""
        return _osascript([f"POSIX path of (choose file with prompt (item 1 of argv){types} "
                           "default location (POSIX file (item 2 of argv)))"], title, start)
    if IS_WINDOWS:
        patterns = VIDEO_PATTERNS if kind == "video" else SUBTITLE_PATTERNS
        label = "Videos" if kind == "video" else "Subtitles"
        return _windows_result(_powershell(
            _WIN_OWNER +
            "$dialog = New-Object System.Windows.Forms.OpenFileDialog\n"
            "$dialog.Title = $env:GIFC_TITLE\n"
            "$dialog.Filter = $env:GIFC_FILTER\n"
            "$dialog.InitialDirectory = $env:GIFC_START\n"
            "if ($dialog.ShowDialog($owner) -eq 'OK') { [Console]::Out.Write($dialog.FileName) }",
            GIFC_TITLE=title, GIFC_FILTER=f"{label}|{patterns}|All files|*.*", GIFC_START=start))
    return _zenity(["--file-selection", f"--title={title}", f"--filename={start}/"])


def choose_folder(start=None):
    """Ask for a folder. Returns a path, or None if canceled."""
    title = "Choose where GIF Creator saves files"
    start = _existing_folder(start)
    if IS_MAC:
        return _osascript(["POSIX path of (choose folder with prompt (item 1 of argv) "
                           "default location (POSIX file (item 2 of argv)))"], title, start)
    if IS_WINDOWS:
        return _windows_result(_powershell(
            _WIN_OWNER +
            "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog\n"
            "$dialog.Description = $env:GIFC_TITLE\n"
            "$dialog.ShowNewFolderButton = $true\n"
            "$dialog.SelectedPath = $env:GIFC_START\n"
            "if ($dialog.ShowDialog($owner) -eq 'OK') { [Console]::Out.Write($dialog.SelectedPath) }",
            GIFC_TITLE=title, GIFC_START=start))
    return _zenity(["--file-selection", "--directory", f"--title={title}", f"--filename={start}/"])


def _zenity(args):
    if not shutil.which("zenity"):
        raise Unsupported("No file picker is available here. Type the path, or drag the file onto the window.")
    r = subprocess.run(["zenity", *args], capture_output=True, text=True)
    return r.stdout.strip() or None


def reveal(path):
    """Show a file selected in Finder or File Explorer."""
    if IS_MAC:
        subprocess.run(["open", "-R", path])
    elif IS_WINDOWS:
        subprocess.run(f'explorer /select,"{path}"')  # explorer exits 1 even when it works
    else:
        subprocess.run(["xdg-open", str(Path(path).parent)])


def open_folder(path):
    if IS_MAC:
        subprocess.run(["open", str(path)])
    elif IS_WINDOWS:
        os.startfile(str(path))
    else:
        subprocess.run(["xdg-open", str(path)])


def copy_file(path):
    """Put the file itself on the clipboard, ready to paste into a chat app or a folder."""
    if IS_MAC:
        _osascript(["set the clipboard to (POSIX file (item 1 of argv))"], path)
    elif IS_WINDOWS:
        r = _powershell("Set-Clipboard -LiteralPath $env:GIFC_PATH", GIFC_PATH=path)
        if r.returncode != 0:
            raise RuntimeError(r.stderr.strip().splitlines()[-1] if r.stderr.strip() else "Couldn't copy the file")
    else:
        raise Unsupported("Copying files isn't supported here. Use “Show in folder” instead.")
