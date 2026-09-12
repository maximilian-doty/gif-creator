// Captions are drawn with the same function for the live preview and for export,
// so what you see over the video is exactly what ends up in the GIF.

// Fonts that come with macOS or Windows. The font menu lists only the ones this computer has.
const FONT_CHOICES = [
  { name: 'Impact', weight: 400 },
  { name: 'Arial Black', weight: 900 },
  { name: 'Helvetica Neue', weight: 700 },
  { name: 'Segoe UI', weight: 700 },
  { name: 'Arial', weight: 700 },
  { name: 'Avenir Next', weight: 700 },
  { name: 'Futura', weight: 700 },
  { name: 'Verdana', weight: 700 },
  { name: 'Trebuchet MS', weight: 700 },
  { name: 'Georgia', weight: 700 },
  { name: 'American Typewriter', weight: 600 },
  { name: 'Courier New', weight: 700 },
  { name: 'Marker Felt', weight: 700 },
  { name: 'Segoe Print', weight: 700 },
  { name: 'Chalkboard SE', weight: 700 },
  { name: 'Comic Sans MS', weight: 700 },
  { name: 'Menlo', weight: 700 },
  { name: 'Consolas', weight: 700 },
];

/** A font is installed if text set in it measures differently from every generic fallback. */
function isInstalled(name) {
  const ctx = document.createElement('canvas').getContext('2d');
  const sample = 'mmmmmmmmmwwwwwlli10';
  return ['monospace', 'serif', 'sans-serif'].some((fallback) => {
    ctx.font = `48px ${fallback}`;
    const plain = ctx.measureText(sample).width;
    ctx.font = `48px "${name}", ${fallback}`;
    return ctx.measureText(sample).width !== plain;
  });
}

export const FONTS = FONT_CHOICES.filter((f) => isInstalled(f.name));

/** The first of these fonts this computer has. */
function firstFont(...names) {
  const f = names.map((n) => FONTS.find((x) => x.name === n)).find(Boolean) || { name: names.at(-1), weight: 700 };
  return { font: f.name, weight: f.weight };
}

export const PRESETS = {
  meme:     { ...firstFont('Impact', 'Arial Black'), size: 11, color: '#ffffff', stroke: '#000000', strokeW: 16, box: false, upper: true, shadow: false },
  subtitle: { ...firstFont('Helvetica Neue', 'Segoe UI', 'Arial'), size: 6.5, color: '#ffffff', stroke: '#000000', strokeW: 13, box: false, upper: false, shadow: true },
  label:    { ...firstFont('Avenir Next', 'Segoe UI', 'Arial'), size: 6, color: '#ffffff', stroke: '#000000', strokeW: 0, box: true, upper: false, shadow: false },
  marker:   { ...firstFont('Marker Felt', 'Segoe Print', 'Comic Sans MS'), size: 8.5, color: '#ffe45c', stroke: '#1a1a1a', strokeW: 12, box: false, upper: false, shadow: false },
};

export const ALIGN_Y = { top: 0.05, middle: 0.5, bottom: 0.94 };

let nextId = 1;

export function newCaption({ preset = 'subtitle', start = 0, end = 2, text = '', align } = {}) {
  const p = PRESETS[preset] || PRESETS.subtitle;
  const a = align || (preset === 'meme' ? 'top' : preset === 'label' ? 'top' : 'bottom');
  return { id: `c${Date.now().toString(36)}${nextId++}`, text, start, end, preset, align: a, x: 0.5, y: ALIGN_Y[a], ...p };
}

export function applyPreset(cap, preset) {
  Object.assign(cap, PRESETS[preset], { preset });
}

function wrap(ctx, text, maxW) {
  const out = [];
  for (const para of text.split('\n')) {
    const words = para.split(/(\s+)/).filter((w) => w.length);
    let line = '';
    for (const word of words) {
      const test = line + word;
      if (line.trim() && ctx.measureText(test.trimEnd()).width > maxW && word.trim()) {
        out.push(line.trimEnd());
        line = word.trimStart();
      } else {
        line = test;
      }
    }
    out.push(line.trim());
  }
  return out;
}

/** Draw one caption into a W×H context. Returns its bounding box in canvas pixels, or null. */
export function drawCaption(ctx, cap, W, H, { alpha = 1 } = {}) {
  const text = cap.upper ? cap.text.toUpperCase() : cap.text;
  if (!text.trim()) return null;
  const px = (cap.size / 100) * H;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.font = `${cap.weight} ${px}px "${cap.font}", "Helvetica Neue", "Segoe UI", Arial, "Apple Color Emoji", "Segoe UI Emoji", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const lines = wrap(ctx, text, W * 0.92);
  const lh = px * 1.14;
  const blockH = lines.length * lh;
  const anchorY = cap.y * H;
  const top = cap.align === 'top' ? anchorY : cap.align === 'bottom' ? anchorY - blockH : anchorY - blockH / 2;
  const cx = cap.x * W;
  const outline = cap.strokeW > 0 ? (cap.strokeW / 100) * px : 0;
  const widths = lines.map((l) => ctx.measureText(l).width);
  const maxW = Math.max(...widths);
  const padX = cap.box ? px * 0.3 : outline;
  const padY = cap.box ? px * 0.12 : outline;

  if (cap.box) {
    ctx.fillStyle = 'rgba(0, 0, 0, 0.72)';
    lines.forEach((l, i) => {
      if (!l) return;
      const y0 = top + i * lh - (i === 0 ? padY : 0);
      const h = lh + (i === 0 ? padY : 0) + (i === lines.length - 1 ? padY : 0) + 0.5;
      ctx.beginPath();
      ctx.roundRect(cx - widths[i] / 2 - padX, y0, widths[i] + padX * 2, h, px * 0.14);
      ctx.fill();
    });
  }

  if (cap.shadow) {
    ctx.shadowColor = 'rgba(0, 0, 0, 0.55)';
    ctx.shadowBlur = px * 0.18;
    ctx.shadowOffsetY = px * 0.05;
  }
  lines.forEach((l, i) => {
    const cy = top + lh * (i + 0.5);
    if (outline) {
      ctx.lineJoin = 'round';
      ctx.miterLimit = 2;
      ctx.lineWidth = outline * 2;
      ctx.strokeStyle = cap.stroke;
      ctx.strokeText(l, cx, cy);
    }
  });
  if (outline) ctx.shadowColor = 'transparent';
  ctx.fillStyle = cap.color;
  lines.forEach((l, i) => ctx.fillText(l, cx, top + lh * (i + 0.5)));
  ctx.restore();

  return { x0: cx - maxW / 2 - padX, y0: top - padY, x1: cx + maxW / 2 + padX, y1: top + blockH + padY };
}

export function isVisibleAt(cap, t) {
  return t >= cap.start && t < cap.end;
}

/** Render a caption alone on a transparent W×H canvas → PNG data URL for export. */
export function captionPNG(cap, W, H) {
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  drawCaption(c.getContext('2d'), cap, W, H);
  return c.toDataURL('image/png');
}
