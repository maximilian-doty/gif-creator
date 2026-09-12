"""Media probing, background jobs, and the ffmpeg / yt-dlp pipelines."""

import base64
import glob
import hashlib
import json
import os
import re
import shutil
import subprocess
import threading
import time
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MEDIA_DIR = ROOT / "media"
EXPORT_DIR = ROOT / "exports"
CACHE_DIR = ROOT / ".cache"
CONFIG_PATH = ROOT / "config.json"

VIDEO_EXTS = {".mp4", ".mov", ".m4v", ".mkv", ".webm", ".avi", ".flv", ".wmv",
              ".mpg", ".mpeg", ".ts", ".m2ts", ".mts", ".3gp", ".ogv"}
TEXT_SUB_CODECS = {"subrip", "ass", "ssa", "mov_text", "webvtt", "text", "srt"}
BROWSER_AUDIO_CODECS = {"aac", "mp3", "opus", "vorbis", "flac"}
SUB_EXTS = {".srt", ".vtt", ".ass", ".ssa"}

for d in (MEDIA_DIR, EXPORT_DIR, CACHE_DIR / "thumbs", CACHE_DIR / "proxy", CACHE_DIR / "audio", CACHE_DIR / "jobs"):
    d.mkdir(parents=True, exist_ok=True)


# ---------------------------------------------------------------- config

def load_config():
    cfg = {
        "port": 8765,
        "library_dirs": ["~/Downloads", "~/Movies", "~/Desktop"],
    }
    if CONFIG_PATH.exists():
        try:
            cfg.update(json.loads(CONFIG_PATH.read_text()))
        except (OSError, ValueError):
            pass
    return cfg


CONFIG = load_config()
OPENED_PATH = CACHE_DIR / "opened.json"
CHOSEN_SUBS_PATH = CACHE_DIR / "chosen_subtitles.json"
_opened_lock = threading.Lock()


def library_dirs():
    dirs = [MEDIA_DIR]
    for d in CONFIG.get("library_dirs", []):
        p = Path(os.path.expanduser(d)).resolve()
        if p.is_dir() and p not in dirs:
            dirs.append(p)
    return dirs


def _recall(store):
    try:
        return [p for p in json.loads(store.read_text()) if os.path.isfile(p)]
    except (OSError, ValueError):
        return []


def _remember(store, path):
    with _opened_lock:
        items = [p for p in _recall(store) if p != path]
        items.insert(0, path)
        store.write_text(json.dumps(items[:50]))


def opened_files():
    return _recall(OPENED_PATH)


def remember_opened(path):
    _remember(OPENED_PATH, path)


def chosen_subtitles():
    return _recall(CHOSEN_SUBS_PATH)


def remember_subtitle(path):
    _remember(CHOSEN_SUBS_PATH, path)


def is_allowed(path):
    """Only serve files inside the library folders, exports, cache, or files the user opened."""
    try:
        real = Path(path).resolve()
    except (OSError, RuntimeError):
        return False
    if not real.is_file():
        return False
    for root in library_dirs() + [EXPORT_DIR, CACHE_DIR]:
        if real.is_relative_to(root):
            return True
    return str(real) in opened_files()


# ---------------------------------------------------------------- library

def scan_library():
    items, seen = [], set()

    def add(p, label):
        rp = str(Path(p).resolve())
        if rp in seen:
            return
        try:
            st = os.stat(rp)
        except OSError:
            return
        seen.add(rp)
        items.append({"path": rp, "name": os.path.basename(rp), "folder": label,
                      "size": st.st_size, "mtime": st.st_mtime})

    for d in library_dirs():
        label = "Downloaded" if d == MEDIA_DIR else d.name
        base_depth = len(d.parts)
        for dirpath, dirnames, filenames in os.walk(d):
            dirnames[:] = [n for n in dirnames if not n.startswith(".") and not n.endswith((".app", ".photoslibrary"))]
            if len(Path(dirpath).parts) - base_depth >= 2:
                dirnames[:] = []
            for f in filenames:
                if not f.startswith(".") and Path(f).suffix.lower() in VIDEO_EXTS:
                    add(os.path.join(dirpath, f), label)
    for p in opened_files():
        add(p, "Opened")
    items.sort(key=lambda i: i["mtime"], reverse=True)
    return items[:600]


def list_exports():
    out = []
    for p in EXPORT_DIR.iterdir():
        if p.suffix.lower() in (".gif", ".mp4", ".webp", ".png") and not p.name.startswith("."):
            st = p.stat()
            out.append({"path": str(p), "name": p.name, "size": st.st_size, "mtime": st.st_mtime})
    out.sort(key=lambda i: i["mtime"], reverse=True)
    return out


def unique_path(directory, name):
    stem, ext = os.path.splitext(name)
    candidate = Path(directory) / name
    n = 2
    while candidate.exists():
        candidate = Path(directory) / f"{stem} ({n}){ext}"
        n += 1
    return candidate


def safe_filename(name, fallback="video"):
    name = os.path.basename(name or "")
    name = re.sub(r'[\\/:*?"<>|\x00-\x1f]', "_", name).strip(" .")
    return name[:180] or fallback


# ---------------------------------------------------------------- probing

_probe_cache = {}


def probe(path):
    st = os.stat(path)
    key = (path, st.st_mtime, st.st_size)
    if key in _probe_cache:
        return _probe_cache[key]
    raw = subprocess.run(
        ["ffprobe", "-v", "error", "-print_format", "json", "-show_format", "-show_streams", path],
        capture_output=True, text=True, timeout=60)
    if raw.returncode != 0:
        raise RuntimeError(raw.stderr.strip() or "ffprobe could not read this file")
    data = json.loads(raw.stdout)
    streams = data.get("streams", [])
    v = next((s for s in streams if s.get("codec_type") == "video"
              and not s.get("disposition", {}).get("attached_pic")), None)
    if not v:
        raise RuntimeError("No video stream found in this file")

    w, h = int(v.get("width", 0)), int(v.get("height", 0))
    sar = 1.0
    sar_str = v.get("sample_aspect_ratio", "1:1")
    if re.fullmatch(r"\d+:\d+", sar_str or "") and not sar_str.startswith("0"):
        a, b = map(int, sar_str.split(":"))
        if b:
            sar = a / b
    rotation = 0
    for sd in v.get("side_data_list", []) or []:
        if "rotation" in sd:
            rotation = int(float(sd["rotation"]))
    if not rotation and "rotate" in v.get("tags", {}):
        rotation = int(v["tags"]["rotate"])
    disp_w = int(round(w * sar / 2) * 2) if abs(sar - 1) > 0.01 else w
    disp_h = h
    if abs(rotation) % 180 == 90:
        disp_w, disp_h = disp_h, disp_w

    def rate(s):
        try:
            a, b = s.split("/")
            return float(a) / float(b) if float(b) else 0
        except (ValueError, AttributeError):
            return 0

    duration = float(data.get("format", {}).get("duration") or v.get("duration") or 0)
    audio = [s for s in streams if s.get("codec_type") == "audio"]
    main_audio = next((s for s in audio if s.get("disposition", {}).get("default")), audio[0] if audio else None)
    result = {
        # Browsers play the first audio track; DTS, AC3, etc. play silently.
        "audio_index": main_audio["index"] if main_audio else None,
        "audio_native": bool(audio) and audio[0].get("codec_name") in BROWSER_AUDIO_CODECS,
        "path": path,
        "name": os.path.basename(path),
        "duration": duration,
        "width": disp_w,
        "height": disp_h,
        "fps": rate(v.get("avg_frame_rate")) or rate(v.get("r_frame_rate")) or 30,
        "vcodec": v.get("codec_name"),
        "sar": sar,
        "size": st.st_size,
        "subtitle_streams": [
            {"index": s["index"], "codec": s.get("codec_name"),
             "language": s.get("tags", {}).get("language"), "title": s.get("tags", {}).get("title")}
            for s in streams if s.get("codec_type") == "subtitle" and s.get("codec_name") in TEXT_SUB_CODECS
        ],
    }
    _probe_cache[key] = result
    return result


def file_key(path, *extra):
    st = os.stat(path)
    return hashlib.sha1(f"{path}|{st.st_mtime}|{st.st_size}|{extra}".encode()).hexdigest()[:20]


_thumb_sem = threading.Semaphore(4)


def thumbnail(path):
    out = CACHE_DIR / "thumbs" / f"{file_key(path)}.jpg"
    if out.exists():
        return out
    with _thumb_sem:
        for seek in ("2", "0"):
            subprocess.run(
                ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-ss", seek, "-i", path,
                 "-frames:v", "1", "-vf", "scale=320:-2", "-q:v", "5", str(out)],
                capture_output=True, timeout=60)
            if out.exists() and out.stat().st_size > 0:
                return out
    return None


def filmstrip(path, count=16):
    """One sprite image of `count` evenly spaced frames, used behind the timeline."""
    out = CACHE_DIR / "thumbs" / f"{file_key(path, 'strip', count)}.jpg"
    if out.exists():
        return out
    info = probe(path)
    dur = info["duration"] or 1
    frame_h = 90
    frame_w = max(2, int(round(frame_h * info["width"] / max(info["height"], 1) / 2) * 2))
    args = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y"]
    for i in range(count):
        args += ["-ss", f"{dur * (i + 0.5) / count:.3f}", "-i", path]
    parts = [f"[{i}:v]scale={frame_w}:{frame_h},setsar=1,trim=end_frame=1[f{i}]" for i in range(count)]
    graph = ";".join(parts) + ";" + "".join(f"[f{i}]" for i in range(count)) + f"hstack=inputs={count}[out]"
    with _thumb_sem:
        r = subprocess.run(args + ["-filter_complex", graph, "-map", "[out]", "-frames:v", "1",
                                   "-q:v", "6", str(out)], capture_output=True, text=True, timeout=180)
    if r.returncode != 0 or not out.exists():
        raise RuntimeError(r.stderr.strip()[-400:] or "Could not build filmstrip")
    return out


# ---------------------------------------------------------------- jobs

JOBS = {}
_jobs_lock = threading.Lock()


class Canceled(Exception):
    pass


class Job:
    def __init__(self, kind, title):
        self.id = uuid.uuid4().hex[:12]
        self.kind = kind
        self.title = title
        self.status = "running"
        self.progress = None
        self.message = "Starting…"
        self.result = None
        self.error = None
        self.started = time.time()
        self.finished = None
        self.proc = None
        self.canceled = False
        with _jobs_lock:
            JOBS[self.id] = self

    def to_dict(self):
        return {"id": self.id, "kind": self.kind, "title": self.title, "status": self.status,
                "progress": self.progress, "message": self.message, "result": self.result,
                "error": self.error, "started": self.started, "finished": self.finished}

    def cancel(self):
        self.canceled = True
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()

    def run(self, fn, *args):
        def target():
            try:
                self.result = fn(self, *args)
                self.status = "done"
                self.progress = 1.0
            except Canceled:
                self.status = "canceled"
                self.message = "Canceled"
            except Exception as e:  # surfaced to the UI
                self.status = "canceled" if self.canceled else "error"
                self.error = str(e)
            finally:
                self.finished = time.time()
                self.proc = None
        threading.Thread(target=target, daemon=True).start()
        return self


def list_jobs():
    cutoff = time.time() - 3600
    with _jobs_lock:
        for jid in [j.id for j in JOBS.values() if j.finished and j.finished < cutoff]:
            del JOBS[jid]
        return [j.to_dict() for j in sorted(JOBS.values(), key=lambda j: j.started, reverse=True)]


def run_ffmpeg(job, args, total_seconds=None, lo=0.0, hi=1.0, cwd=None):
    """Run ffmpeg, mapping its -progress output onto job.progress in [lo, hi]."""
    if job.canceled:
        raise Canceled()
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostats", "-progress", "pipe:1", "-y"] + args
    job.proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, cwd=cwd)
    err_lines = []
    t = threading.Thread(target=lambda: err_lines.extend(job.proc.stderr), daemon=True)
    t.start()
    for line in job.proc.stdout:
        if line.startswith("out_time_us=") and total_seconds:
            try:
                secs = int(line.split("=", 1)[1]) / 1e6
            except ValueError:
                continue
            job.progress = lo + (hi - lo) * max(0.0, min(1.0, secs / total_seconds))
    job.proc.wait()
    t.join(timeout=2)
    if job.canceled:
        raise Canceled()
    if job.proc.returncode != 0:
        msg = "".join(err_lines).strip().splitlines()
        raise RuntimeError(msg[-1] if msg else f"ffmpeg exited with code {job.proc.returncode}")
    job.progress = hi


# ---------------------------------------------------------------- proxy (for formats the browser can't play)

def proxy_path(path):
    return CACHE_DIR / "proxy" / f"{file_key(path, 'with-audio')}.mp4"


def preview_audio_path(path):
    return CACHE_DIR / "audio" / f"{file_key(path)}.m4a"


def _aac_args(info):
    if info["audio_index"] is None:
        return ["-an"]
    return ["-map", f"0:{info['audio_index']}", "-map_chapters", "-1", "-c:a", "aac", "-b:a", "128k", "-ac", "2"]


def make_proxy(job, path):
    out = proxy_path(path)
    if out.exists():
        return {"path": str(out)}
    info = probe(path)
    tmp = out.with_suffix(".part.mp4")
    job.message = "Converting for preview"
    run_ffmpeg(job, ["-i", path, "-map", "0:v:0", "-vf", "scale=-2:'min(720,ih)'",
                     "-c:v", "libx264", "-preset", "veryfast", "-crf", "24", "-g", "12",
                     "-pix_fmt", "yuv420p", *_aac_args(info), "-movflags", "+faststart", str(tmp)],
               total_seconds=info["duration"])
    tmp.rename(out)
    return {"path": str(out)}


def make_preview_audio(job, path):
    """AAC copy of the sound for videos whose audio the browser can't decode."""
    out = preview_audio_path(path)
    if out.exists():
        return {"path": str(out)}
    info = probe(path)
    if info["audio_index"] is None:
        raise RuntimeError("This video has no sound")
    tmp = out.with_suffix(".part.m4a")
    job.message = "Converting sound for preview"
    run_ffmpeg(job, ["-i", path, "-vn", *_aac_args(info), "-movflags", "+faststart", str(tmp)],
               total_seconds=info["duration"])
    tmp.rename(out)
    return {"path": str(out)}


# ---------------------------------------------------------------- export

DITHER = {
    "sierra": "dither=sierra2_4a",
    "bayer": "dither=bayer:bayer_scale=3",
    "floyd": "dither=floyd_steinberg",
    "none": "dither=none",
}


def audio_graph(stream_index, speed, boomerang, fps):
    """Sound for an MP4 export, retimed to match the video: input 1 is the trimmed source."""
    chain = ["asetpts=PTS-STARTPTS"]
    s = speed
    while s < 0.5:  # atempo only goes down to 0.5×, so chain it for slower speeds
        chain.append("atempo=0.5")
        s /= 0.5
    if abs(s - 1) > 1e-3:
        chain.append(f"atempo={s:.4f}")
    graph = f"[1:{stream_index}]{','.join(chain)}"
    if boomerang:  # the reversed half drops one frame, so drop one frame of sound too
        return (graph + f",asplit[af][ab];[ab]areverse,atrim=start={1 / fps:.4f},asetpts=PTS-STARTPTS[ar];"
                "[af][ar]concat=n=2:v=0:a=1[aout]")
    return graph + "[aout]"


def num(v, lo, hi, default):
    try:
        v = float(v)
    except (TypeError, ValueError):
        return default
    return max(lo, min(hi, v))


def display_filters(info):
    """Square the pixels of anamorphic video so crop coordinates match what the browser shows."""
    return ["scale=round(iw*sar/2)*2:ih,setsar=1"] if abs(info["sar"] - 1) > 0.01 else []


def crop_rect(info, crop):
    """Validated (w, h, x, y) in display pixels, or None for the full frame."""
    if not crop:
        return None
    cw = int(num(crop.get("w"), 2, info["width"], info["width"]))
    ch = int(num(crop.get("h"), 2, info["height"], info["height"]))
    cx = int(num(crop.get("x"), 0, info["width"] - cw, 0))
    cy = int(num(crop.get("y"), 0, info["height"] - ch, 0))
    return None if (cw, ch) == (info["width"], info["height"]) else (cw, ch, cx, cy)


def export_frame(req):
    """Save the frame at the playhead as a full-resolution PNG, with any visible text."""
    src = req["path"]
    info = probe(src)
    t = num(req.get("time"), 0, info["duration"], 0)
    rect = crop_rect(info, req.get("crop"))
    w, h = rect[:2] if rect else (info["width"], info["height"])
    chain = display_filters(info) + (["crop={}:{}:{}:{}".format(*rect)] if rect else [])

    stem = safe_filename(Path(info["name"]).stem, "frame")[:60]
    minutes, seconds = divmod(t, 60)
    out_path = unique_path(EXPORT_DIR, f"{stem} frame {int(minutes)}m{seconds:05.2f}s.png")
    work = CACHE_DIR / "jobs" / uuid.uuid4().hex[:12]
    work.mkdir(parents=True, exist_ok=True)
    try:
        filters = ",".join(chain) or "null"
        label, caption_input, overlay = "v", [], ""
        if req.get("captions"):
            cap = work / "captions.png"
            cap.write_bytes(base64.b64decode(req["captions"].split(",", 1)[-1]))
            caption_input = ["-i", str(cap)]
            overlay = ";[v][1:v]overlay=0:0:format=rgb[out]"
            label = "out"
        tmp = work / "frame.png"

        def render(seek_args, frame_args, window_end=None):
            # -t lets one frame past the end through, so the exact cut is a trim filter.
            trim = f"trim=end={window_end:.6f}," if window_end is not None else ""
            return subprocess.run(
                ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *seek_args, "-i", src, *caption_input,
                 "-filter_complex", f"[0:v]{trim}{filters}[v]{overlay}", "-map", f"[{label}]",
                 *frame_args, str(tmp)],
                capture_output=True, text=True, timeout=180)

        # The browser shows the last frame that starts at or before the playhead. Decode a short window
        # ending at the playhead and keep the final frame (-update 1 rewrites the image for each frame).
        start = max(0.0, t - 0.5)
        window = t + 0.0002 - start
        r = render(["-ss", f"{start:.6f}", "-t", f"{window + 0.25:.6f}"], ["-update", "1"], window_end=window)
        if not tmp.exists():  # nothing in the window, e.g. a file whose first frame starts late
            r = render(["-ss", f"{t:.6f}"], ["-frames:v", "1"])
        if not tmp.exists():
            lines = r.stderr.strip().splitlines()
            raise RuntimeError(lines[-1] if lines else "Couldn't read a frame at that time")
        shutil.move(str(tmp), out_path)
    finally:
        shutil.rmtree(work, ignore_errors=True)
    return {"kind": "frame", "path": str(out_path), "name": out_path.name, "size": out_path.stat().st_size,
            "width": w, "height": h, "time": t}


def export(job, req):
    src = req["path"]
    info = probe(src)
    start = num(req.get("start"), 0, info["duration"], 0)
    end = num(req.get("end"), start + 0.05, info["duration"] or start + 1, start + 3)
    clip = end - start
    fps = num(req.get("fps"), 1, 60, 15)
    speed = num(req.get("speed"), 0.1, 8, 1)
    fmt = req.get("format") if req.get("format") in ("gif", "mp4", "webp") else "gif"
    out_w = int(num(req.get("out_w"), 16, 4096, 480)) // 2 * 2
    out_h = int(num(req.get("out_h"), 16, 4096, 270)) // 2 * 2
    boomerang = bool(req.get("boomerang"))
    with_sound = fmt == "mp4" and bool(req.get("sound")) and info["audio_index"] is not None

    work = CACHE_DIR / "jobs" / job.id
    work.mkdir(parents=True, exist_ok=True)
    try:
        chain = display_filters(info)
        # Sample the source at fps/speed; retiming every frame to 1/fps then plays it `speed` times faster.
        chain.append(f"fps={fps / speed:.4f}")
        rect = crop_rect(info, req.get("crop"))
        if rect:
            chain.append("crop={}:{}:{}:{}".format(*rect))
        chain.append(f"scale={out_w}:{out_h}:flags=lanczos,setsar=1")

        inputs = ["-ss", f"{start:.3f}", "-t", f"{clip:.3f}", "-i", src]
        graph = [f"[0:v]{','.join(chain)}[b0]"]
        label = "b0"
        captions = [c for c in (req.get("captions") or []) if c.get("png")]
        for i, cap in enumerate(captions):
            png = cap["png"].split(",", 1)[-1]
            cap_file = work / f"cap{i}.png"
            cap_file.write_bytes(base64.b64decode(png))
            cs = max(0.0, num(cap.get("start"), 0, 1e9, 0) - start)
            ce = max(0.0, num(cap.get("end"), 0, 1e9, 0) - start)
            if ce <= cs:
                continue
            inputs += ["-i", str(cap_file)]
            n = inputs.count("-i") - 1  # ffmpeg input index of this caption
            nxt = f"b{i + 1}"
            graph.append(f"[{label}][{n}:v]overlay=0:0:format=rgb:enable='between(t,{cs:.3f},{ce:.3f})'[{nxt}]")
            label = nxt
        # Space frames 1/fps apart, then re-declare the rate: the encoder sizes its timebase from the
        # declared rate (still fps/speed), which above 1× is too coarse and merges neighbouring frames.
        retime = f"settb=AVTB,setpts=N/({fps:g}*TB),fps={fps:g}"
        if boomerang:
            graph.append(f"[{label}]{retime},split[fw][bw];[bw]reverse,trim=start_frame=1,{retime}[rv];"
                         f"[fw][rv]concat=n=2:v=1:a=0[out]")
        else:
            graph.append(f"[{label}]{retime}[out]")
        out_seconds = clip / speed * (2 if boomerang else 1)

        stem = safe_filename(Path(req.get("name") or info["name"]).stem, "clip")[:60]
        stamp = time.strftime("%Y%m%d-%H%M%S")
        out_path = unique_path(EXPORT_DIR, f"{stem} {stamp}.{fmt}")

        job.message = "Rendering frames"
        inter = work / "frames.mkv"
        run_ffmpeg(job, inputs + ["-filter_complex", ";".join(graph), "-map", "[out]",
                                  "-an", "-sn", "-c:v", "ffv1", "-pix_fmt", "bgr0", str(inter)],
                   total_seconds=out_seconds, lo=0, hi=0.75)

        loop = bool(req.get("loop", True))
        if fmt == "gif":
            colors = int(num(req.get("colors"), 8, 256, 256))
            dither = DITHER.get(req.get("dither"), DITHER["sierra"])
            job.message = "Building color palette"
            palette = work / "palette.png"
            run_ffmpeg(job, ["-i", str(inter), "-vf",
                             f"palettegen=max_colors={colors}:reserve_transparent=0:stats_mode=full",
                             str(palette)], lo=0.75, hi=0.8)
            job.message = "Encoding GIF"
            run_ffmpeg(job, ["-i", str(inter), "-i", str(palette), "-lavfi",
                             f"[0:v][1:v]paletteuse={dither}:diff_mode=rectangle",
                             "-loop", "0" if loop else "-1", str(out_path)],
                       total_seconds=out_seconds, lo=0.8, hi=1.0)
        elif fmt == "mp4":
            job.message = "Encoding MP4"
            sound = []
            if with_sound:
                sound = ["-ss", f"{start:.3f}", "-t", f"{clip:.3f}", "-i", src,
                         "-filter_complex", audio_graph(info["audio_index"], speed, boomerang, fps),
                         "-map", "0:v:0", "-map", "[aout]", "-c:a", "aac", "-b:a", "160k", "-ac", "2",
                         "-shortest"]
            run_ffmpeg(job, ["-i", str(inter), *sound, "-map_chapters", "-1",
                             "-c:v", "libx264", "-preset", "medium", "-crf", "18",
                             "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(out_path)],
                       total_seconds=out_seconds, lo=0.75, hi=1.0)
        else:
            job.message = "Encoding WebP"
            run_ffmpeg(job, ["-i", str(inter), "-c:v", "libwebp_anim", "-quality", "80",
                             "-compression_level", "5", "-loop", "0" if loop else "1", str(out_path)],
                       total_seconds=out_seconds, lo=0.75, hi=1.0)
        job.message = "Done"
        return {"path": str(out_path), "name": out_path.name, "size": out_path.stat().st_size,
                "width": out_w, "height": out_h, "duration": out_seconds,
                "frames": int(round(out_seconds * fps)), "sound": with_sound}
    finally:
        shutil.rmtree(work, ignore_errors=True)


# ---------------------------------------------------------------- yt-dlp

PROGRESS_TAG = "GCDL"


def ts_to_seconds(s):
    """Accept 90, 1:30, 01:02:03.5 → seconds."""
    s = str(s or "").strip()
    if not s:
        return None
    parts = s.split(":")
    try:
        total = 0.0
        for p in parts:
            total = total * 60 + float(p)
        return total
    except ValueError:
        raise ValueError(f"Can't read the time “{s}”. Use seconds or m:ss.")


def download(job, req):
    url = (req.get("url") or "").strip()
    if not re.match(r"^https?://", url):
        raise ValueError("Paste a link that starts with http:// or https://")
    sec_start = ts_to_seconds(req.get("section_start"))
    sec_end = ts_to_seconds(req.get("section_end"))
    cmd = ["yt-dlp", "--newline", "--progress", "--no-simulate", "--no-playlist", "--no-mtime",
           "--no-colors", "-P", str(MEDIA_DIR), "-o", "%(title).80B [%(id)s].%(ext)s",
           "-S", "res:1080,vcodec:h264,acodec:aac,ext:mp4:m4a", "--merge-output-format", "mp4",
           "--progress-template",
           f"download:{PROGRESS_TAG}|%(progress.status)s|%(progress.downloaded_bytes)s|"
           f"%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s",
           "--print", "before_dl:GCTITLE|%(title)s",
           "--print", "after_move:GCFILE|%(filepath)s"]
    if sec_start is not None or sec_end is not None:
        a = sec_start or 0
        b = f"{sec_end}" if sec_end is not None else "inf"
        cmd += ["--download-sections", f"*{a}-{b}"]
    if req.get("subs"):
        cmd += ["--write-subs", "--write-auto-subs", "--sub-langs", "en,en-US,en-GB,en-orig",
                "--convert-subs", "srt"]
    cmd += ["--", url]

    job.message = "Looking up video"
    job.proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    final_path, tail = None, []
    for line in job.proc.stdout:
        line = line.rstrip("\n")
        if line.startswith(PROGRESS_TAG + "|"):
            _, status, done, total, est, speed, eta = (line.split("|") + [""] * 7)[:7]
            total_b = next((float(x) for x in (total, est) if re.fullmatch(r"[\d.]+", x or "")), None)
            if re.fullmatch(r"[\d.]+", done or "") and total_b:
                job.progress = min(0.99, float(done) / total_b)
            parts = ["Downloading"]
            if re.fullmatch(r"[\d.]+", speed or ""):
                parts.append(f"{float(speed) / 1e6:.1f} MB/s")
            if re.fullmatch(r"[\d.]+", eta or ""):
                parts.append(f"{int(float(eta))}s left")
            job.message = ", ".join(parts)
        elif line.startswith("GCTITLE|"):
            job.title = line.split("|", 1)[1]
        elif line.startswith("GCFILE|"):
            final_path = line.split("|", 1)[1]
        elif "[Merger]" in line or "[VideoConvertor]" in line:
            job.progress, job.message = None, "Merging audio and video"
        elif "[SubtitlesConvertor]" in line or "Writing video subtitles" in line:
            job.message = "Saving subtitles"
        elif line.strip():
            tail.append(line)
    job.proc.wait()
    if job.canceled:
        raise Canceled()
    if job.proc.returncode != 0 or not final_path:
        errs = [l for l in tail if "ERROR" in l] or tail[-3:] or ["yt-dlp failed"]
        raise RuntimeError(errs[-1].replace("ERROR: ", ""))

    if req.get("subs") and sec_start:
        stem = os.path.splitext(final_path)[0]
        for sub in glob.glob(glob.escape(stem) + ".*.srt"):
            cues = [c for c in parse_srt(Path(sub).read_text(errors="replace"))]
            shifted = [dict(c, start=c["start"] - sec_start, end=c["end"] - sec_start)
                       for c in cues if c["end"] > sec_start]
            Path(sub).write_text(write_srt(shifted))
    job.message = "Downloaded"
    return {"path": final_path, "name": os.path.basename(final_path)}


# ---------------------------------------------------------------- subtitles

def _srt_time(t):
    m = re.match(r"(?:(\d+):)?(\d+):(\d+)[.,](\d+)", t.strip())
    if not m:
        return 0.0
    hh, mm, ss, frac = m.groups()
    return int(hh or 0) * 3600 + int(mm) * 60 + int(ss) + float("0." + frac)


def parse_srt(text):
    cues = []
    for block in re.split(r"\r?\n\s*\r?\n", text.strip()):
        lines = block.strip().splitlines()
        idx = next((i for i, l in enumerate(lines) if "-->" in l), None)
        if idx is None:
            continue
        a, b = lines[idx].split("-->", 1)
        body = "\n".join(lines[idx + 1:])
        body = re.sub(r"\{\\[^}]*\}", "", body)          # ASS override tags
        body = re.sub(r"</?[a-zA-Z][^>]*>", "", body)     # <i>, <font>, <c> ...
        body = body.replace("\\N", "\n").replace("&amp;", "&").replace("&gt;", ">").replace("&lt;", "<")
        body = "\n".join(l.strip() for l in body.splitlines() if l.strip())
        if body:
            cues.append({"start": _srt_time(a), "end": _srt_time(b.split()[0]), "text": body})
    return cues


def write_srt(cues):
    def fmt(t):
        t = max(0.0, t)
        ms = int(round(t * 1000))
        return f"{ms // 3600000:02d}:{ms // 60000 % 60:02d}:{ms // 1000 % 60:02d},{ms % 1000:03d}"
    return "\n".join(f"{i}\n{fmt(c['start'])} --> {fmt(c['end'])}\n{c['text']}\n"
                     for i, c in enumerate(cues, 1))


def clean_rolling_captions(cues):
    """YouTube auto-captions repeat the previous line in each cue; keep only the new text."""
    out, prev_lines = [], set()
    for c in cues:
        if c["end"] - c["start"] < 0.05:
            prev_lines.update(c["text"].splitlines())
            continue
        lines = [l for l in c["text"].splitlines() if l not in prev_lines]
        prev_lines = set(c["text"].splitlines())
        if lines:
            out.append(dict(c, text="\n".join(lines)))
    return out


# Ad and credit lines that subtitle sites insert ("sync & correction by … Addic7ed.com").
CREDIT_CUE = re.compile(r"addic7ed|opensubtitles|subscene|podnapisi|\byify\b|sync(ed)?\s*(&|and)\s*correct"
                        r"|corrected\s+by|subtitles?\s+(by|ripped)", re.I)


def subtitle_sources(path):
    info = probe(path)
    stem = os.path.splitext(path)[0]
    sources, seen = [], set()
    for ext in ("srt", "vtt", "ass", "ssa"):
        for f in sorted(glob.glob(glob.escape(stem) + f"*.{ext}")):
            seen.add(str(Path(f).resolve()))
            sources.append({"id": "file:" + f, "label": f"With the video ({os.path.basename(f)[len(os.path.basename(stem)):].strip('. ')})"})
    for s in info["subtitle_streams"]:
        label = " ".join(x for x in (s.get("title"), s.get("language"), f"({s['codec']})") if x)
        sources.append({"id": f"stream:{s['index']}", "label": f"Embedded: {label}"})
    for f in chosen_subtitles():
        if f not in seen:
            sources.append({"id": "file:" + f, "label": f"Chosen: {os.path.basename(f)}"})
    return sources


def read_subtitle_text(path):
    raw = Path(path).read_bytes()
    if raw.startswith((b"\xff\xfe", b"\xfe\xff")):
        return raw.decode("utf-16")
    for encoding in ("utf-8-sig", "cp1252"):  # subtitle sites often serve Windows-1252
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            pass
    return raw.decode("utf-8", errors="replace")


def subtitle_cues(path, source):
    if source.startswith("file:"):
        sub = str(Path(source[5:]).resolve())
        beside_video = Path(sub).parent == Path(path).resolve().parent
        if not (beside_video or sub in chosen_subtitles()):
            raise ValueError("Pick this subtitle file with “Choose file…” first")
        if Path(sub).suffix.lower() == ".srt":
            text = read_subtitle_text(sub)
        else:
            text = _ffmpeg_to_srt(["-i", sub])
    elif source.startswith("stream:"):
        text = _ffmpeg_to_srt(["-i", path, "-map", f"0:{int(source[7:])}"])
    else:
        raise ValueError("Unknown subtitle source")
    cues = [c for c in parse_srt(text) if not CREDIT_CUE.search(c["text"])]
    return clean_rolling_captions(cues)


def _ffmpeg_to_srt(args):
    r = subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error"] + args + ["-f", "srt", "pipe:1"],
                       capture_output=True, text=True, timeout=120)
    if r.returncode != 0:
        raise RuntimeError(r.stderr.strip()[-300:] or "Could not read subtitles")
    return r.stdout
