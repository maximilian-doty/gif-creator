"""Local HTTP server for GIF Creator. Binds to 127.0.0.1 only."""

import argparse
import json
import mimetypes
import os
import shutil
import socket
import sys
import threading
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent))
import core  # noqa: E402
import desktop  # noqa: E402

STATIC_DIR = Path(__file__).resolve().parent / "static"
CHUNK = 1024 * 256
MAX_JSON = 200 * 1024 * 1024  # caption PNGs travel inside export requests

MIME_OVERRIDES = {".mkv": "video/webm", ".m4v": "video/mp4", ".m4a": "audio/mp4", ".ts": "video/mp2t", ".mts": "video/mp2t",
                  ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".webp": "image/webp"}


class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


class Handler(BaseHTTPRequestHandler):
    server_version = "GIFCreator/1.0"

    def log_message(self, fmt, *args):
        if "--verbose" in sys.argv:
            super().log_message(fmt, *args)

    # ---------------------------------------------------------------- plumbing

    def _host_ok(self):
        host = (self.headers.get("Host") or "").split(":")[0]
        return host in ("127.0.0.1", "localhost")

    def _json(self, obj, status=200):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_JSON:
            raise ApiError(413, "Request too large")
        try:
            return json.loads(self.rfile.read(length) or b"{}")
        except ValueError:
            raise ApiError(400, "Invalid JSON")

    def _path_param(self, q, key="path"):
        path = (q.get(key) or [""])[0]
        if not path or not core.is_allowed(path):
            raise ApiError(404, "File not found or not in a library folder")
        return str(Path(path).resolve())

    def _body_path(self, req):
        return self._path_param({"path": [req.get("path", "")]})

    def _send_file(self, path, cache=False):
        size = os.path.getsize(path)
        ext = Path(path).suffix.lower()
        ctype = MIME_OVERRIDES.get(ext) or mimetypes.guess_type(path)[0] or "application/octet-stream"
        start, end = 0, size - 1
        rng = self.headers.get("Range")
        status = 200
        if rng and rng.startswith("bytes="):
            a, _, b = rng[6:].split(",")[0].partition("-")
            try:
                if a:
                    start = int(a)
                    end = int(b) if b else size - 1
                else:
                    start = max(0, size - int(b))
                end = min(end, size - 1)
                if start > end:
                    raise ValueError
                status = 206
            except ValueError:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                self.end_headers()
                return
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(end - start + 1))
        if status == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Cache-Control", "max-age=3600" if cache else "no-cache")
        self.end_headers()
        if self.command == "HEAD":
            return
        try:
            with open(path, "rb") as f:
                f.seek(start)
                remaining = end - start + 1
                while remaining > 0:
                    chunk = f.read(min(CHUNK, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass

    def _dispatch(self, routes):
        if not self._host_ok():
            return self._json({"error": "Bad host"}, 403)
        url = urlparse(self.path)
        q = parse_qs(url.query)
        fn = routes.get(url.path)
        try:
            if fn:
                return fn(self, q)
            if self.command in ("GET", "HEAD"):
                return self._static(url.path)
            raise ApiError(404, "Not found")
        except ApiError as e:
            self._json({"error": str(e)}, e.status)
        except core.NotConfigured as e:
            self._json({"error": str(e), "needs_setup": True}, 409)
        except desktop.Unsupported as e:
            self._json({"error": str(e)}, 501)
        except ValueError as e:
            self._json({"error": str(e)}, 400)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass
        except Exception as e:
            self._json({"error": str(e)}, 500)

    def _static(self, path):
        rel = "index.html" if path in ("", "/") else path.lstrip("/")
        target = (STATIC_DIR / rel).resolve()
        if not target.is_relative_to(STATIC_DIR) or not target.is_file():
            raise ApiError(404, "Not found")
        self._send_file(str(target))

    def do_GET(self):
        self._dispatch(GET_ROUTES)

    def do_HEAD(self):
        self._dispatch(GET_ROUTES)

    def do_POST(self):
        # A custom header forces a CORS preflight, which this server never approves,
        # so other websites can't drive the local API.
        if self.headers.get("X-GIF-Creator") != "1":
            return self._json({"error": "Missing X-GIF-Creator header"}, 403)
        self._dispatch(POST_ROUTES)

    # ---------------------------------------------------------------- GET routes

    def get_settings(self, q):
        self._json(core.settings_info())

    def get_library(self, q):
        self._json({"items": core.scan_library(), "exports": core.list_exports(),
                    "folders": [str(d) for d in core.library_dirs()], "platform": core.PLATFORM})

    def get_media(self, q):
        self._send_file(self._path_param(q))

    def get_thumb(self, q):
        out = core.thumbnail(self._path_param(q))
        if not out:
            raise ApiError(404, "No thumbnail")
        self._send_file(str(out), cache=True)

    def get_strip(self, q):
        count = max(4, min(40, int((q.get("n") or ["16"])[0])))
        self._send_file(str(core.filmstrip(self._path_param(q), count)), cache=True)

    def get_probe(self, q):
        path = self._path_param(q)
        info = core.probe(path)
        proxy = core.proxy_path(path)
        audio = core.preview_audio_path(path)
        self._json(dict(info, proxy=str(proxy) if proxy.exists() else None,
                        preview_audio=str(audio) if audio.exists() else None))

    def get_jobs(self, q):
        self._json({"jobs": core.list_jobs()})

    def get_subs(self, q):
        self._json({"sources": core.subtitle_sources(self._path_param(q))})

    def get_sub_cues(self, q):
        path = self._path_param(q)
        source = (q.get("source") or [""])[0]
        self._json({"cues": core.subtitle_cues(path, source)})

    # ---------------------------------------------------------------- POST routes

    def post_settings(self, q):
        req = self._read_json()
        core.save_settings(req.get("save_dir"), req.get("library_dirs"))
        self._json(core.settings_info())

    def post_choose_folder(self, q):
        path = desktop.choose_folder(self._read_json().get("start"))
        self._json({"path": path} if path else {"canceled": True})

    def post_download(self, q):
        req = self._read_json()
        core.media_dir()  # needs setup first
        core.ts_to_seconds(req.get("section_start"))  # validate early so errors show inline
        core.ts_to_seconds(req.get("section_end"))
        job = core.Job("download", req.get("url", "")).run(core.download, req)
        self._json(job.to_dict())

    def post_export(self, q):
        req = self._read_json()
        req["path"] = self._body_path(req)
        core.export_dir()
        job = core.Job("export", os.path.basename(req["path"])).run(core.export, req)
        self._json(job.to_dict())

    def post_frame(self, q):
        req = self._read_json()
        req["path"] = self._body_path(req)
        self._json(core.export_frame(req))

    def post_proxy(self, q):
        path = self._body_path(self._read_json())
        job = core.Job("proxy", os.path.basename(path)).run(core.make_proxy, path)
        self._json(job.to_dict())

    def post_preview_audio(self, q):
        path = self._body_path(self._read_json())
        job = core.Job("audio", os.path.basename(path)).run(core.make_preview_audio, path)
        self._json(job.to_dict())

    def post_cancel(self, q):
        job = core.JOBS.get(self._read_json().get("id"))
        if job:
            job.cancel()
        self._json({"ok": True})

    def post_upload(self, q):
        name = core.safe_filename(unquote(self.headers.get("X-Filename", "")))
        if Path(name).suffix.lower() not in core.VIDEO_EXTS:
            raise ApiError(400, "That file type isn't a supported video")
        length = int(self.headers.get("Content-Length") or 0)
        dest = core.unique_path(core.media_dir(), name)
        tmp = dest.with_name("." + dest.name + ".part")
        with open(tmp, "wb") as f:
            remaining = length
            while remaining > 0:
                chunk = self.rfile.read(min(CHUNK * 4, remaining))
                if not chunk:
                    break
                f.write(chunk)
                remaining -= len(chunk)
        if remaining:
            tmp.unlink(missing_ok=True)
            raise ApiError(400, "Upload was interrupted")
        tmp.rename(dest)
        self._json({"path": str(dest), "name": dest.name})

    def post_open_dialog(self, q):
        chosen = desktop.choose_file("video")
        if not chosen:
            return self._json({"canceled": True})
        path = str(Path(chosen).resolve())
        core.remember_opened(path)
        self._json({"path": path, "name": os.path.basename(path)})

    def post_subs_choose(self, q):
        chosen = desktop.choose_file("subtitle")
        if not chosen:
            return self._json({"canceled": True})
        path = str(Path(chosen).resolve())
        if Path(path).suffix.lower() not in core.SUB_EXTS:
            raise ApiError(400, "That isn't a subtitle file. Pick a .srt, .vtt, .ass, or .ssa file.")
        core.remember_subtitle(path)
        self._json({"id": "file:" + path, "name": os.path.basename(path)})

    def post_reveal(self, q):
        desktop.reveal(self._body_path(self._read_json()))
        self._json({"ok": True})

    def post_copy(self, q):
        desktop.copy_file(self._body_path(self._read_json()))
        self._json({"ok": True})

    def post_open_folder(self, q):
        which = self._read_json().get("folder")
        desktop.open_folder(core.export_dir() if which == "exports" else core.media_dir())
        self._json({"ok": True})


GET_ROUTES = {
    "/api/settings": Handler.get_settings,
    "/api/library": Handler.get_library,
    "/api/media": Handler.get_media,
    "/api/thumb": Handler.get_thumb,
    "/api/strip": Handler.get_strip,
    "/api/probe": Handler.get_probe,
    "/api/jobs": Handler.get_jobs,
    "/api/subs": Handler.get_subs,
    "/api/subs/cues": Handler.get_sub_cues,
}
POST_ROUTES = {
    "/api/settings": Handler.post_settings,
    "/api/choose-folder": Handler.post_choose_folder,
    "/api/download": Handler.post_download,
    "/api/export": Handler.post_export,
    "/api/frame": Handler.post_frame,
    "/api/proxy": Handler.post_proxy,
    "/api/preview-audio": Handler.post_preview_audio,
    "/api/cancel": Handler.post_cancel,
    "/api/upload": Handler.post_upload,
    "/api/open-dialog": Handler.post_open_dialog,
    "/api/subs/choose": Handler.post_subs_choose,
    "/api/reveal": Handler.post_reveal,
    "/api/copy": Handler.post_copy,
    "/api/open-folder": Handler.post_open_folder,
}

INSTALL_HINTS = {
    "mac": {"ffmpeg": "brew install ffmpeg", "yt-dlp": "brew install yt-dlp"},
    "windows": {"ffmpeg": "winget install Gyan.FFmpeg", "yt-dlp": "winget install yt-dlp.yt-dlp"},
    "linux": {"ffmpeg": "sudo apt install ffmpeg", "yt-dlp": "python3 -m pip install --user yt-dlp"},
}


PORT_TRIES = 20


class Server(ThreadingHTTPServer):
    daemon_threads = True
    # On Windows, SO_REUSEADDR lets two programs share a port, which would hide a conflict.
    allow_reuse_address = not core.IS_WINDOWS


def _in_use(port):
    """Whether some program already accepts connections on this port."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.3)
        return s.connect_ex(("127.0.0.1", port)) == 0


def _is_gif_creator(port):
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/jobs", timeout=1) as r:
            return r.headers.get("Server", "").startswith("GIFCreator")
    except OSError:
        return False


def _open_server(ports):
    """Bind the first free port in `ports`, skipping ones other programs hold."""
    for port in ports:
        if _in_use(port):
            continue
        try:
            return Server(("127.0.0.1", port), Handler), port
        except OSError:
            continue
    return None, None


def main():
    ap = argparse.ArgumentParser(description="GIF Creator local server")
    ap.add_argument("--port", type=int, help="port to use (default: the one used last time, else 8765)")
    ap.add_argument("--no-open", action="store_true", help="don't open a browser tab")
    ap.add_argument("--verbose", action="store_true")
    args = ap.parse_args()
    sys.stdout.reconfigure(line_buffering=True)  # show messages right away, even when output goes to a log

    hints = INSTALL_HINTS[core.PLATFORM]
    if not (shutil.which("ffmpeg") and shutil.which("ffprobe")):
        print("GIF Creator needs ffmpeg, which isn't installed (or isn't on your PATH yet).")
        print(f"Install it with:  {hints['ffmpeg']}")
        print("Then close this window, open a new one, and start GIF Creator again.")
        sys.exit(1)
    if not core.ytdlp_command():
        print(f"Note: yt-dlp isn't installed, so pasting links won't work. Install it with:  {hints['yt-dlp']}")

    # Prefer the port used last time: the browser keeps saved edits separately for each address.
    base = args.port or core.config().get("port", 8765)
    preferred = args.port or core.config().get("last_port") or base
    ports = list(dict.fromkeys([preferred, *range(base, base + PORT_TRIES)]))

    running = next((p for p in ports if _in_use(p) and _is_gif_creator(p)), None)
    if running:
        url = f"http://127.0.0.1:{running}/"
        print(f"GIF Creator is already running at {url}")
        if not args.no_open:
            webbrowser.open(url)
        return

    httpd, port = _open_server(ports)
    if not httpd:
        print(f"Ports {base} to {base + PORT_TRIES - 1} are all in use by other programs. "
              f"Start GIF Creator on another one, for example:  python app/server.py --port 9000")
        sys.exit(1)
    if port != preferred:
        print(f"Another program is using port {preferred}, so GIF Creator is using {port} instead.")
    if not args.port:
        core.remember_port(port)
    url = f"http://127.0.0.1:{port}/"
    print(f"GIF Creator is running at {url}")
    print("Keep this window open while you use it. Close it or press Ctrl+C to stop.")
    if not args.no_open:
        threading.Timer(0.4, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
