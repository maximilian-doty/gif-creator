import { clamp } from './api.js';
import { drawCaption, isVisibleAt } from './captions.js';

const MIN_CROP = 16;

/** The video frame: fits the video to the stage, draws the crop box and caption preview, handles dragging. */
export class Stage {
  constructor(els, cb) {
    Object.assign(this, els); // stage, frame, video, cropEl, canvas
    this.cb = cb; // { onCrop(crop, done), onAspectAuto(aspect), onCaptionMove(cap, done), onSelectCaption(id), onClick() }
    this.ctx = this.canvas.getContext('2d');
    this.srcW = 16;
    this.srcH = 9;
    this.scale = 1;
    this.aspect = 'full';
    this.crop = { x: 0, y: 0, w: 16, h: 9 };
    this.captions = [];
    this.selectedId = null;
    this.time = 0;
    this.bounds = new Map();
    this.visibleKey = '';

    new ResizeObserver(() => this.layout()).observe(this.stage);
    this.frame.addEventListener('pointerdown', (e) => this.onDown(e));
    this.frame.addEventListener('pointermove', (e) => this.onHover(e));
  }

  load(w, h) {
    this.srcW = w;
    this.srcH = h;
    this.aspect = 'full';
    this.crop = { x: 0, y: 0, w, h };
    this.layout();
  }

  isFull() {
    const c = this.crop;
    return c.x < 1 && c.y < 1 && Math.abs(c.w - this.srcW) < 1 && Math.abs(c.h - this.srcH) < 1;
  }

  roundedCrop() {
    const c = this.crop;
    const w = Math.max(2, Math.round(c.w / 2) * 2);
    const h = Math.max(2, Math.round(c.h / 2) * 2);
    return { x: clamp(Math.round(c.x), 0, this.srcW - w), y: clamp(Math.round(c.y), 0, this.srcH - h), w, h };
  }

  setAspect(aspect) {
    this.aspect = aspect;
    if (aspect === 'full') {
      this.crop = { x: 0, y: 0, w: this.srcW, h: this.srcH };
    } else if (typeof aspect === 'number') {
      // largest rectangle of this shape, centered on the current crop
      const c = this.crop;
      const cx = c.x + c.w / 2;
      const cy = c.y + c.h / 2;
      let w = this.srcW;
      let h = w / aspect;
      if (h > this.srcH) { h = this.srcH; w = h * aspect; }
      this.crop = { w, h, x: clamp(cx - w / 2, 0, this.srcW - w), y: clamp(cy - h / 2, 0, this.srcH - h) };
    }
    this.layout();
    this.cb.onCrop(this.roundedCrop(), true);
  }

  setCaptions(caps, selectedId) {
    this.captions = caps;
    this.selectedId = selectedId;
    this.draw();
  }

  setTime(t) {
    this.time = t;
    const key = this.captions.filter((c) => isVisibleAt(c, t)).map((c) => c.id).join();
    if (key !== this.visibleKey) this.draw();
  }

  // ------------------------------------------------------------ layout & drawing

  layout() {
    const r = this.stage.getBoundingClientRect();
    const availW = Math.max(r.width - 32, 50);
    const availH = Math.max(r.height - 32, 50);
    this.scale = Math.min(availW / this.srcW, availH / this.srcH);
    this.frame.style.width = `${this.srcW * this.scale}px`;
    this.frame.style.height = `${this.srcH * this.scale}px`;
    const c = this.crop;
    Object.assign(this.cropEl.style, {
      left: `${c.x * this.scale}px`, top: `${c.y * this.scale}px`,
      width: `${c.w * this.scale}px`, height: `${c.h * this.scale}px`,
    });
    this.cropEl.classList.toggle('full', this.isFull());
    const dpr = window.devicePixelRatio || 1;
    const cw = Math.max(1, Math.round(c.w * this.scale * dpr));
    const ch = Math.max(1, Math.round(c.h * this.scale * dpr));
    if (this.canvas.width !== cw || this.canvas.height !== ch) {
      this.canvas.width = cw;
      this.canvas.height = ch;
    }
    this.draw();
  }

  draw() {
    const { ctx, canvas } = this;
    const W = canvas.width;
    const H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    this.bounds.clear();
    const visible = this.captions.filter((c) => isVisibleAt(c, this.time));
    this.visibleKey = visible.map((c) => c.id).join();
    const selected = this.captions.find((c) => c.id === this.selectedId);
    for (const cap of this.captions) {
      const shown = isVisibleAt(cap, this.time);
      if (!shown && cap !== selected) continue;
      const b = drawCaption(ctx, cap, W, H, { alpha: shown ? 1 : 0.35 });
      if (b) this.bounds.set(cap.id, b);
    }
    const b = selected && this.bounds.get(selected.id);
    if (b) {
      const dpr = window.devicePixelRatio || 1;
      ctx.save();
      ctx.setLineDash([5 * dpr, 4 * dpr]);
      ctx.lineWidth = 1.5 * dpr;
      ctx.strokeStyle = '#8fb8f5';
      ctx.strokeRect(b.x0 - 4 * dpr, b.y0 - 4 * dpr, b.x1 - b.x0 + 8 * dpr, b.y1 - b.y0 + 8 * dpr);
      ctx.restore();
    }
  }

  // ------------------------------------------------------------ interaction

  /** Caption under a client point, preferring the selected one. */
  captionAt(clientX, clientY) {
    const r = this.cropEl.getBoundingClientRect();
    const k = this.canvas.width / r.width;
    const px = (clientX - r.left) * k;
    const py = (clientY - r.top) * k;
    const pad = 6 * k;
    const hit = (id) => {
      const b = this.bounds.get(id);
      return b && px >= b.x0 - pad && px <= b.x1 + pad && py >= b.y0 - pad && py <= b.y1 + pad;
    };
    if (this.selectedId && hit(this.selectedId)) return this.captions.find((c) => c.id === this.selectedId);
    return [...this.captions].reverse().find((c) => isVisibleAt(c, this.time) && hit(c.id));
  }

  onHover(e) {
    if (e.buttons) return;
    this.cropEl.classList.toggle('cap-hover', !!this.captionAt(e.clientX, e.clientY));
  }

  onDown(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    const handle = e.target.dataset?.h;
    const x0 = e.clientX;
    const y0 = e.clientY;
    const start = { ...this.crop };
    const frame = this.frame;
    frame.setPointerCapture(e.pointerId);
    let moved = false;
    let onMove;
    let onUp = () => {};

    const cap = !handle && this.captionAt(e.clientX, e.clientY);
    const cropRect = this.cropEl.getBoundingClientRect();
    const insideCrop = x0 >= cropRect.left && x0 <= cropRect.right && y0 >= cropRect.top && y0 <= cropRect.bottom;

    if (handle) {
      if (this.aspect === 'full') { this.aspect = 'free'; this.cb.onAspectAuto('free'); }
      onMove = (dx, dy) => { this.crop = this.resized(start, handle, dx / this.scale, dy / this.scale); this.layout(); this.cb.onCrop(this.roundedCrop(), false); };
      onUp = () => this.cb.onCrop(this.roundedCrop(), true);
    } else if (cap) {
      this.cb.onSelectCaption(cap.id);
      const cx0 = cap.x;
      const cy0 = cap.y;
      onMove = (dx, dy) => {
        cap.x = clamp(cx0 + dx / cropRect.width, 0, 1);
        cap.y = clamp(cy0 + dy / cropRect.height, 0, 1);
        this.draw();
        this.cb.onCaptionMove(cap, false);
      };
      onUp = () => this.cb.onCaptionMove(cap, true);
      this.cropEl.classList.add('cap-drag');
    } else if (insideCrop && !this.isFull()) {
      onMove = (dx, dy) => {
        this.crop = { ...start, x: clamp(start.x + dx / this.scale, 0, this.srcW - start.w), y: clamp(start.y + dy / this.scale, 0, this.srcH - start.h) };
        this.layout();
        this.cb.onCrop(this.roundedCrop(), false);
      };
      onUp = () => this.cb.onCrop(this.roundedCrop(), true);
    } else {
      onMove = () => {};
    }

    const move = (ev) => {
      const dx = ev.clientX - x0;
      const dy = ev.clientY - y0;
      if (!moved && Math.hypot(dx, dy) < 3) return;
      moved = true;
      onMove(dx, dy);
    };
    const up = () => {
      frame.removeEventListener('pointermove', move);
      frame.removeEventListener('pointerup', up);
      frame.removeEventListener('pointercancel', up);
      this.cropEl.classList.remove('cap-drag');
      if (moved) onUp();
      else if (!cap && !handle) this.cb.onClick();
    };
    frame.addEventListener('pointermove', move);
    frame.addEventListener('pointerup', up);
    frame.addEventListener('pointercancel', up);
  }

  /** New crop rect after dragging `handle` by (dx, dy) source pixels, honoring the aspect lock. */
  resized(s, handle, dx, dy) {
    const W = this.srcW;
    const H = this.srcH;
    let x0 = s.x;
    let y0 = s.y;
    let x1 = s.x + s.w;
    let y1 = s.y + s.h;
    if (handle.includes('w')) x0 = clamp(x0 + dx, 0, x1 - MIN_CROP);
    if (handle.includes('e')) x1 = clamp(x1 + dx, x0 + MIN_CROP, W);
    if (handle.includes('n')) y0 = clamp(y0 + dy, 0, y1 - MIN_CROP);
    if (handle.includes('s')) y1 = clamp(y1 + dy, y0 + MIN_CROP, H);
    const R = typeof this.aspect === 'number' ? this.aspect : null;
    if (!R) return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };

    let w = x1 - x0;
    let h = y1 - y0;
    if (handle === 'n' || handle === 's') w = h * R;
    else if (handle === 'e' || handle === 'w') h = w / R;
    else if (w / h > R) h = w / R;
    else w = h * R;

    // anchor: the edge opposite the handle, or the center for the perpendicular axis
    const ax = handle.includes('w') ? s.x + s.w : handle.includes('e') ? s.x : s.x + s.w / 2;
    const ay = handle.includes('n') ? s.y + s.h : handle.includes('s') ? s.y : s.y + s.h / 2;
    const maxW = handle.includes('w') ? ax : handle.includes('e') ? W - ax : 2 * Math.min(ax, W - ax);
    const maxH = handle.includes('n') ? ay : handle.includes('s') ? H - ay : 2 * Math.min(ay, H - ay);
    const k = Math.min(1, maxW / w, maxH / h);
    w *= k;
    h *= k;
    const x = handle.includes('w') ? ax - w : handle.includes('e') ? ax : ax - w / 2;
    const y = handle.includes('n') ? ay - h : handle.includes('s') ? ay : ay - h / 2;
    return { x, y, w, h };
  }
}
