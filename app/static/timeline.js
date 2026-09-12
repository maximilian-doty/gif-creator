import { clamp, fmtTime } from './api.js';

const MIN_CLIP = 0.1;
const MIN_CAP = 0.1;
const LANE_ROW = 30;
const TICK_STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];

/** Filmstrip timeline: clip range grips, playhead, zoom/pan, and a lane of caption bars. */
export class Timeline {
  constructor(el, cb) {
    this.el = el;
    this.cb = cb; // { onSeek(t), onRange(start, end), onCaption(cap, done), onSelectCaption(id) }
    this.track = el.querySelector('#track');
    this.strip = el.querySelector('#strip');
    this.rangeEl = el.querySelector('#range');
    this.shadeL = el.querySelector('#shade-l');
    this.shadeR = el.querySelector('#shade-r');
    this.playhead = el.querySelector('#playhead');
    this.ruler = el.querySelector('#ruler');
    this.lane = el.querySelector('#lane');
    this.hint = el.querySelector('#lane-hint');
    this.rows = new Map();
    this.frozenRows = null;
    this.duration = 1;
    this.a = 0;
    this.b = 1;
    this.start = 0;
    this.end = 1;
    this.time = 0;
    this.captions = [];
    this.selectedId = null;

    this.track.addEventListener('pointerdown', (e) => this.onTrackDown(e));
    this.lane.addEventListener('pointerdown', (e) => this.onLaneDown(e));
    for (const target of [this.track, this.lane, this.ruler]) {
      target.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    }
    new ResizeObserver(() => this.render()).observe(this.track);
  }

  // ------------------------------------------------------------ state

  load(duration, stripUrl) {
    this.duration = Math.max(duration, 0.1);
    this.a = 0;
    this.b = this.duration;
    this.strip.style.backgroundImage = stripUrl ? `url("${stripUrl}")` : 'none';
    this.render();
  }

  setRange(start, end) { this.start = start; this.end = end; this.renderRange(); }
  setTime(t) { this.time = t; this.renderPlayhead(); }
  setCaptions(caps, selectedId) { this.captions = caps; this.selectedId = selectedId; this.renderLane(); this.renderHint(); }

  zoomTo(a, b) {
    const span = clamp(b - a, 0.5, this.duration);
    a = clamp(a, 0, this.duration - span);
    this.a = a;
    this.b = a + span;
    this.render();
  }
  fit() { this.zoomTo(0, this.duration); }
  zoomToClip() {
    const len = this.end - this.start;
    const pad = Math.max(len * 0.35, 1);
    this.zoomTo(this.start - pad, this.end + pad);
  }

  // ------------------------------------------------------------ geometry

  x(t) { return ((t - this.a) / (this.b - this.a)) * 100; }
  timeAt(clientX) {
    const r = this.track.getBoundingClientRect();
    return clamp(this.a + ((clientX - r.left) / r.width) * (this.b - this.a), 0, this.duration);
  }
  secPerPx() { return (this.b - this.a) / this.track.getBoundingClientRect().width; }

  // ------------------------------------------------------------ render

  render() {
    const span = this.b - this.a;
    this.strip.style.left = `${this.x(0)}%`;
    this.strip.style.width = `${(this.duration / span) * 100}%`;
    this.renderRuler();
    this.renderRange();
    this.renderPlayhead();
    this.renderLane();
  }

  renderRuler() {
    const width = this.track.getBoundingClientRect().width || 800;
    const span = this.b - this.a;
    const step = TICK_STEPS.find((s) => (s / span) * width >= 72) || 3600;
    const precise = step < 1;
    let html = '';
    for (let t = Math.ceil(this.a / step) * step; t <= this.b + 1e-6; t += step) {
      html += `<span style="left:${this.x(t)}%">${fmtTime(t, precise).replace(/\.?0+$/, precise ? '' : '')}</span>`;
    }
    this.ruler.innerHTML = html;
  }

  renderRange() {
    const l = this.x(this.start);
    const r = this.x(this.end);
    this.rangeEl.style.left = `${l}%`;
    this.rangeEl.style.width = `${Math.max(r - l, 0)}%`;
    this.shadeL.style.left = '0';
    this.shadeL.style.width = `${clamp(l, 0, 100)}%`;
    this.shadeR.style.left = `${clamp(r, 0, 100)}%`;
    this.shadeR.style.right = '0';
  }

  renderPlayhead() {
    const x = this.x(this.time);
    this.playhead.style.left = `${x}%`;
    this.playhead.hidden = x < 0 || x > 100;
  }

  renderHint(cap) {
    if (cap) {
      this.hint.textContent = `Shows ${fmtTime(cap.start)} to ${fmtTime(cap.end)} (${(cap.end - cap.start).toFixed(2)} s)`;
    } else {
      this.hint.textContent = this.captions.length
        ? 'Click a line to edit it. Drag it or its ends to change when it shows.'
        : 'Text you add lines up here with the video.';
    }
  }

  renderLane() {
    if (!this.frozenRows) {
      // Overlapping lines go on separate rows so none hides another.
      this.rows = new Map();
      const rowEnds = [];
      for (const c of [...this.captions].sort((a, b) => a.start - b.start)) {
        let row = rowEnds.findIndex((end) => end <= c.start + 1e-3);
        if (row === -1) { row = rowEnds.length; rowEnds.push(c.end); } else rowEnds[row] = c.end;
        this.rows.set(c.id, row);
      }
    }
    const rows = this.frozenRows || this.rows;
    const rowCount = Math.max(1, ...[...rows.values()].map((r) => r + 1));
    this.lane.style.height = `${rowCount * LANE_ROW + 4}px`;
    this.lane.replaceChildren(...this.captions.map((c) => {
      const bar = document.createElement('div');
      bar.className = 'cap-bar';
      bar.dataset.id = c.id;
      bar.setAttribute('aria-selected', String(c.id === this.selectedId));
      bar.style.left = `${this.x(c.start)}%`;
      bar.style.width = `${this.x(c.end) - this.x(c.start)}%`;
      bar.style.top = `${4 + (rows.get(c.id) ?? 0) * LANE_ROW}px`;
      bar.title = `${c.text || 'Empty text'} (${fmtTime(c.start)} to ${fmtTime(c.end)})`;
      bar.textContent = c.text || 'Empty text';
      bar.insertAdjacentHTML('beforeend', '<span class="edge l" data-edge="l"></span><span class="edge r" data-edge="r"></span>');
      return bar;
    }));
  }

  // ------------------------------------------------------------ interaction

  drag(e, onMove, onUp) {
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    const move = (ev) => onMove(ev);
    const up = (ev) => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      target.removeEventListener('pointercancel', up);
      onUp?.(ev);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
    target.addEventListener('pointercancel', up);
  }

  onTrackDown(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    const grip = e.target.closest('[data-grip]')?.dataset.grip;
    const t0 = this.timeAt(e.clientX);
    const { start: s0, end: e0 } = this;

    if (grip) {
      this.drag(e, (ev) => {
        const t = this.timeAt(ev.clientX);
        if (grip === 'in') this.start = clamp(t, 0, this.end - MIN_CLIP);
        else this.end = clamp(t, this.start + MIN_CLIP, this.duration);
        this.renderRange();
        this.cb.onRange(this.start, this.end, grip);
      }, () => this.cb.onRange(this.start, this.end, grip, true));
      return;
    }

    if (e.target === this.rangeEl) {
      let moved = false;
      const x0 = e.clientX;
      this.drag(e, (ev) => {
        if (!moved && Math.abs(ev.clientX - x0) < 4) return;
        moved = true;
        const len = e0 - s0;
        const s = clamp(s0 + (this.timeAt(ev.clientX) - t0), 0, this.duration - len);
        this.start = s;
        this.end = s + len;
        this.renderRange();
        this.cb.onRange(this.start, this.end, 'move');
      }, (ev) => {
        if (moved) this.cb.onRange(this.start, this.end, 'move', true);
        else this.cb.onSeek(this.timeAt(ev.clientX));
      });
      return;
    }

    this.cb.onSeek(t0);
    this.drag(e, (ev) => this.cb.onSeek(this.timeAt(ev.clientX)));
  }

  onLaneDown(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    const bar = e.target.closest('.cap-bar');
    if (!bar) { // empty space works like the filmstrip: jump there
      this.cb.onSeek(this.timeAt(e.clientX));
      this.drag(e, (ev) => this.cb.onSeek(this.timeAt(ev.clientX)));
      return;
    }
    const cap = this.captions.find((c) => c.id === bar.dataset.id);
    if (!cap) return;
    const edge = e.target.dataset.edge;
    const x0 = e.clientX;
    const t0 = this.timeAt(x0);
    const { start: s0, end: e0 } = cap;
    let moved = false;
    this.cb.onSelectCaption(cap.id);
    this.frozenRows = new Map(this.rows); // keep the bar on its row while it moves
    this.drag(e, (ev) => {
      if (!moved && Math.abs(ev.clientX - x0) < 4) return;
      moved = true;
      const dt = this.timeAt(ev.clientX) - t0;
      if (edge === 'l') cap.start = clamp(s0 + dt, 0, e0 - MIN_CAP);
      else if (edge === 'r') cap.end = clamp(e0 + dt, s0 + MIN_CAP, this.duration);
      else {
        const len = e0 - s0;
        cap.start = clamp(s0 + dt, 0, this.duration - len);
        cap.end = cap.start + len;
      }
      this.renderLane();
      this.renderHint(cap);
      this.cb.onCaption(cap, false);
    }, () => {
      this.frozenRows = null;
      this.renderLane();
      this.renderHint();
      if (moved) this.cb.onCaption(cap, true);
      else this.cb.onCaptionClick(cap);
    });
  }

  onWheel(e) {
    e.preventDefault();
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      const span = this.b - this.a;
      this.zoomTo(this.a + e.deltaX * this.secPerPx(), this.a + e.deltaX * this.secPerPx() + span);
      return;
    }
    const pivot = this.timeAt(e.clientX);
    const factor = Math.exp(e.deltaY * (e.ctrlKey ? 0.01 : 0.002));
    const span = clamp((this.b - this.a) * factor, 0.5, this.duration);
    const frac = (pivot - this.a) / (this.b - this.a);
    this.zoomTo(pivot - frac * span, pivot - frac * span + span);
  }
}
