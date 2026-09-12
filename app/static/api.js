export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export async function api(path, { json, method, headers = {}, body } = {}) {
  const init = { method: method || (json !== undefined || body ? 'POST' : 'GET'), headers: { ...headers } };
  if (json !== undefined) {
    init.body = JSON.stringify(json);
    init.headers['Content-Type'] = 'application/json';
  } else if (body) {
    init.body = body;
  }
  if (init.method !== 'GET') init.headers['X-GIF-Creator'] = '1';
  const res = await fetch(path, init);
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data;
}

export const enc = encodeURIComponent;
export const mediaUrl = (p) => `/api/media?path=${enc(p)}`;

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** 83.456 → "1:23.46" (precise) or "1:23" */
export function fmtTime(t, precise = true) {
  if (!Number.isFinite(t)) t = 0;
  t = Math.max(0, t);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const ss = precise ? s.toFixed(2).padStart(5, '0') : String(Math.floor(s)).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** "1:23.5", "83.5", "1:02:03" → seconds, or NaN */
export function parseTime(str) {
  const s = String(str ?? '').trim();
  if (!s) return NaN;
  let total = 0;
  for (const part of s.split(':')) {
    if (!/^\d*\.?\d+$/.test(part)) return NaN;
    total = total * 60 + parseFloat(part);
  }
  return total;
}

export function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function fmtAgo(epochSec) {
  const d = Date.now() / 1000 - epochSec;
  if (d < 60) return 'just now';
  if (d < 3600) return `${Math.floor(d / 60)} min ago`;
  if (d < 86400) return `${Math.floor(d / 3600)} hr ago`;
  if (d < 86400 * 30) return `${Math.floor(d / 86400)} days ago`;
  return new Date(epochSec * 1000).toLocaleDateString();
}

let toastTimer;
export function toast(msg, { error = false, ms = 3200 } = {}) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('error', error);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, error ? ms * 1.8 : ms);
}

export function store(key, value) {
  try {
    if (value === undefined) return JSON.parse(localStorage.getItem(`gifc:${key}`));
    localStorage.setItem(`gifc:${key}`, JSON.stringify(value));
  } catch { return undefined; }
}
