import { $, $$, api, enc, mediaUrl, clamp, fmtTime, parseTime, fmtBytes, fmtAgo, toast, store } from './api.js';
import { FONTS, ALIGN_Y, newCaption, applyPreset, captionPNG, drawCaption, isVisibleAt } from './captions.js';
import { Timeline } from './timeline.js';
import { Stage } from './stage.js';

const DEFAULT_SETTINGS = { format: 'gif', width: 480, fps: 15, colors: 256, dither: 'sierra', loop: true, sound: true, speed: 1, boomerang: false, preset: 'subtitle', muted: false };

const S = {
  library: [],
  exports: [],
  tab: 'videos',
  filter: '',
  info: null,
  usingProxy: false,
  start: 0,
  end: 0,
  captions: [],
  selectedId: null,
  crop: null,
  settings: { ...DEFAULT_SETTINGS, ...(store('settings') || {}) },
  jobs: new Map(),
  exportJobId: null,
  lastResult: null,
};

const video = $('#video');
// Browsers can't decode some audio (DTS, AC3…). For those files the server makes an AAC
// copy of the sound, which plays here and is kept in step with the video.
const audio = $('#preview-audio');

// ================================================================ stage & timeline

const stage = new Stage(
  { stage: $('#stage'), frame: $('#frame'), video, cropEl: $('#crop'), canvas: $('#cap-canvas') },
  {
    onCrop(crop, done) { S.crop = crop; renderCropHint(); updateEstimate(); if (done) saveSession(); },
    onAspectAuto(aspect) { syncAspectButtons(aspect); },
    onCaptionMove(cap, done) { if (done) { renderCaptions(); saveSession(); } },
    onSelectCaption(id) { selectCaption(id); },
    onClick() { togglePlay(); },
  },
);

const timeline = new Timeline($('#timeline'), {
  onSeek(t) { seek(t); },
  onRange(start, end, which, done) {
    S.start = start;
    S.end = end;
    syncClipInputs();
    updateEstimate();
    if (!done && which !== 'move') seek(which === 'in' ? start : end);
    if (done) { saveSession(); if (which === 'move') seek(start); }
  },
  onCaption(cap, done) { stage.draw(); if (done) { renderCaptions(); saveSession(); } else fillEditorTimes(); },
  onSelectCaption(id) { selectCaption(id); },
  onCaptionClick(cap) {
    const t = video.currentTime;
    if (t < cap.start || t >= cap.end) { video.pause(); seek(cap.start + 0.01); }
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    $('#cap-editor').scrollIntoView({ block: 'nearest', behavior: reduceMotion ? 'auto' : 'smooth' });
  },
});

// ================================================================ library

async function refreshLibrary() {
  try {
    const data = await api('/api/library');
    // Re-rendering replaces the list items, which would swallow a click already in progress
    // (clicking into the window fires `focus` → refresh), so only render real changes.
    const sig = JSON.stringify([data.items, data.exports]);
    if (sig === S.librarySig) return;
    S.librarySig = sig;
    S.library = data.items;
    S.exports = data.exports;
    renderLibrary();
  } catch (err) {
    toast(`Couldn't read the library: ${err.message}`, { error: true });
  }
}

function renderLibrary() {
  const f = S.filter.toLowerCase();
  const vids = S.library.filter((i) => i.name.toLowerCase().includes(f));
  const list = $('#lib-list');
  list.replaceChildren(...vids.map((item) => {
    const li = document.createElement('li');
    li.className = 'lib-item';
    li.tabIndex = 0;
    li.setAttribute('aria-current', String(S.info?.path === item.path));
    li.innerHTML = `<img class="lib-thumb" loading="lazy" alt="" src="/api/thumb?path=${enc(item.path)}">
      <div><div class="lib-name"></div><div class="lib-meta"></div></div>`;
    li.querySelector('.lib-name').textContent = item.name;
    li.querySelector('.lib-meta').textContent = `${item.folder}, ${fmtBytes(item.size)}, ${fmtAgo(item.mtime)}`;
    li.querySelector('img').addEventListener('error', (e) => { e.target.style.visibility = 'hidden'; });
    const open = () => openVideo(item.path);
    li.addEventListener('click', open);
    li.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
    return li;
  }));
  if (!vids.length) {
    list.innerHTML = `<li class="lib-empty">${S.filter ? 'No videos match that filter.' : 'No videos yet. Paste a link above or drop a file here.'}</li>`;
  }

  const exps = S.exports.filter((i) => i.name.toLowerCase().includes(f));
  const elist = $('#exp-list');
  elist.replaceChildren(...exps.map((item) => {
    const li = document.createElement('li');
    li.className = 'lib-item';
    const isVideo = item.name.endsWith('.mp4');
    li.innerHTML = `<img class="lib-thumb" loading="lazy" alt="" src="${isVideo ? `/api/thumb?path=${enc(item.path)}` : mediaUrl(item.path)}">
      <div><div class="lib-name"></div><div class="lib-meta"></div>
      <div class="exp-actions"><button class="link" data-act="copy">Copy file</button><button class="link" data-act="reveal">Show in Finder</button></div></div>`;
    li.querySelector('.lib-name').textContent = item.name;
    li.querySelector('.lib-meta').textContent = `${fmtBytes(item.size)}, ${fmtAgo(item.mtime)}`;
    li.querySelector('[data-act=copy]').addEventListener('click', () => copyFile(item.path));
    li.querySelector('[data-act=reveal]').addEventListener('click', () => reveal(item.path));
    return li;
  }));
  if (!exps.length) elist.innerHTML = '<li class="lib-empty">Your exported GIFs will show up here.</li>';

  $('#lib-count').textContent = S.tab === 'videos'
    ? `${S.library.length} video${S.library.length === 1 ? '' : 's'}`
    : `${S.exports.length} export${S.exports.length === 1 ? '' : 's'}`;
}

function setTab(tab) {
  S.tab = tab;
  $$('.tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === tab)));
  $('#lib-list').hidden = tab !== 'videos';
  $('#exp-list').hidden = tab !== 'exports';
  renderLibrary();
}

async function copyFile(path) {
  try { await api('/api/copy', { json: { path } }); toast('Copied. Paste it into Slack, Messages, or a folder.'); }
  catch (err) { toast(err.message, { error: true }); }
}
async function reveal(path) {
  try { await api('/api/reveal', { json: { path } }); } catch (err) { toast(err.message, { error: true }); }
}

// ================================================================ jobs

const watchers = new Map();
let pollTimer = null;

function trackJob(job, handlers = {}) {
  S.jobs.set(job.id, { ...job, list: handlers.list });
  watchers.set(job.id, handlers);
  renderJobs();
  if (!pollTimer) pollTimer = setTimeout(poll, 400);
}

async function poll() {
  pollTimer = null;
  try {
    const { jobs } = await api('/api/jobs');
    for (const j of jobs) {
      const w = watchers.get(j.id);
      if (!w) continue;
      S.jobs.set(j.id, { ...j, list: w.list });
      if (j.status === 'running') { w.onProgress?.(j); continue; }
      watchers.delete(j.id);
      if (j.status === 'done') {
        w.onDone?.(j);
        setTimeout(() => { S.jobs.delete(j.id); renderJobs(); }, 2500);
      } else if (j.status === 'error') {
        w.onError?.(j);
      } else {
        w.onCancel?.(j);
        S.jobs.delete(j.id);
      }
    }
  } catch { /* server restarting; try again */ }
  renderJobs();
  if (watchers.size) pollTimer = setTimeout(poll, 500);
}

function renderJobs() {
  const rows = [...S.jobs.values()].filter((j) => j.list);
  $('#jobs-list').replaceChildren(...rows.map((j) => {
    const div = document.createElement('div');
    div.className = `job ${j.status}`;
    const pct = j.progress != null ? `${Math.round(j.progress * 100)}%` : '';
    const msg = j.status === 'error' ? j.error : j.status === 'done' ? 'Added to your library' : j.message;
    div.innerHTML = `<div class="job-title"></div><div class="job-msg"><span class="m"></span><span>${j.status === 'running' ? pct : ''}</span></div>
      ${j.status === 'running' ? `<div class="progress ${j.progress == null ? 'indeterminate' : ''}"><div class="bar" style="width:${(j.progress || 0) * 100}%"></div></div>` : ''}
      <div class="exp-actions">${j.status === 'running' && j.kind !== 'upload' ? '<button class="link" data-act="cancel">Cancel</button>' : ''}
      ${j.status === 'error' ? '<button class="link" data-act="dismiss">Dismiss</button>' : ''}</div>`;
    div.querySelector('.job-title').textContent = j.title || 'Download';
    div.querySelector('.m').textContent = msg || '';
    div.querySelector('[data-act=cancel]')?.addEventListener('click', () => api('/api/cancel', { json: { id: j.id } }));
    div.querySelector('[data-act=dismiss]')?.addEventListener('click', () => { S.jobs.delete(j.id); renderJobs(); });
    return div;
  }));
}

// ================================================================ downloads, uploads, open

$('#dl-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = $('#dl-url').value.trim();
  try {
    const job = await api('/api/download', {
      json: { url, section_start: $('#dl-start').value, section_end: $('#dl-end').value, subs: $('#dl-subs').checked },
    });
    $('#dl-url').value = '';
    toggleOptions(false);
    setTab('videos');
    trackJob(job, {
      list: true,
      async onDone(j) {
        await refreshLibrary();
        if (!S.info) openVideo(j.result.path);
        else toast(`Downloaded “${j.result.name}”. It's at the top of your library.`);
      },
      onError(j) { toast(`Download failed: ${j.error}`, { error: true }); },
    });
  } catch (err) {
    toast(err.message, { error: true });
  }
});

function toggleOptions(open = $('#dl-options').hidden) {
  $('#dl-options').hidden = !open;
  $('#dl-options-btn').setAttribute('aria-expanded', String(open));
}
$('#dl-options-btn').addEventListener('click', () => toggleOptions());
document.addEventListener('pointerdown', (e) => {
  if (!$('#dl-options').hidden && !e.target.closest('#dl-form')) toggleOptions(false);
});

$('#open-btn').addEventListener('click', async () => {
  try {
    const r = await api('/api/open-dialog', { json: {} });
    if (r.path) { await refreshLibrary(); openVideo(r.path); }
  } catch (err) { toast(err.message, { error: true }); }
});

function upload(file) {
  const id = `up-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const job = { id, kind: 'upload', title: file.name, status: 'running', progress: 0, message: 'Adding to library', list: true };
  S.jobs.set(id, job);
  renderJobs();
  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/upload');
  xhr.setRequestHeader('X-GIF-Creator', '1');
  xhr.setRequestHeader('X-Filename', encodeURIComponent(file.name));
  xhr.upload.onprogress = (e) => { if (e.lengthComputable) { job.progress = e.loaded / e.total; renderJobs(); } };
  xhr.onload = async () => {
    let data = {};
    try { data = JSON.parse(xhr.responseText); } catch { /* ignore */ }
    if (xhr.status !== 200) {
      Object.assign(job, { status: 'error', error: data.error || 'Upload failed' });
      renderJobs();
      return;
    }
    Object.assign(job, { status: 'done', progress: 1 });
    renderJobs();
    setTimeout(() => { S.jobs.delete(id); renderJobs(); }, 2000);
    await refreshLibrary();
    openVideo(data.path);
  };
  xhr.onerror = () => { Object.assign(job, { status: 'error', error: 'Upload failed' }); renderJobs(); };
  xhr.send(file);
}

let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
window.addEventListener('dragenter', (e) => { if (hasFiles(e)) { dragDepth++; $('#drop').hidden = false; } });
window.addEventListener('dragleave', (e) => { if (hasFiles(e) && --dragDepth <= 0) { dragDepth = 0; $('#drop').hidden = true; } });
window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  $('#drop').hidden = true;
  [...e.dataTransfer.files].forEach(upload);
});

// ================================================================ opening a video

async function openVideo(path) {
  if (S.info?.path === path) return;
  saveSession();
  video.pause();
  let info;
  try {
    info = await api(`/api/probe?path=${enc(path)}`);
  } catch (err) {
    toast(`Can't open this file: ${err.message}`, { error: true });
    return;
  }
  S.info = info;
  S.usingProxy = false;
  S.lastResult = null;
  $('#result').hidden = true;
  $('#subs-picker').hidden = true;
  $('#sound-out').disabled = info.audio_index == null;
  $('#sound-label').textContent = info.audio_index == null ? 'Include sound (this video has none)' : 'Include sound';
  hideStageMsg();

  for (const id of ['#stage', '#transport', '#timeline', '#inspector']) $(id).hidden = false;
  $('#empty').hidden = true;

  const sess = store(`session:${path}`);
  S.start = clamp(sess?.start ?? 0, 0, info.duration);
  S.end = clamp(sess?.end ?? Math.min(info.duration, 4), S.start + 0.1, info.duration);
  S.captions = sess?.captions || [];
  S.selectedId = null;

  stage.load(info.width, info.height);
  if (sess?.crop && sess.aspect !== 'full') {
    stage.crop = sess.crop;
    stage.aspect = sess.aspect;
    stage.layout();
  }
  S.crop = stage.roundedCrop();
  syncAspectButtons(stage.aspect);
  renderCropHint();

  const trackW = $('#track').getBoundingClientRect().width || 900;
  const n = clamp(Math.round(trackW / (56 * (info.width / info.height))), 6, 40);
  timeline.load(info.duration, `/api/strip?path=${enc(path)}&n=${n}`);
  timeline.setRange(S.start, S.end);
  if (info.duration > 120) timeline.zoomToClip();

  $('#tc-dur').textContent = fmtTime(info.duration, false);
  detachAudio();
  setVideoSrc(path, S.start);
  if (info.audio_index != null && !info.audio_native) useExternalAudio();
  syncClipInputs();
  renderCaptions();
  updateEstimate();
  renderLibrary();
}

function setVideoSrc(path, at) {
  video.src = mediaUrl(path);
  applyMute();
  video.playbackRate = S.settings.speed;
  video.addEventListener('loadedmetadata', () => {
    video.playbackRate = S.settings.speed;
    seek(at);
  }, { once: true });
}

video.addEventListener('error', () => handleUnplayable());
video.addEventListener('loadeddata', () => { if (!video.videoWidth) handleUnplayable(); });

async function handleUnplayable() {
  if (!S.info || !video.getAttribute('src')) return;
  if (S.usingProxy) { showStageMsg("This video can't be previewed, but you can still try exporting it."); return; }
  const { path } = S.info;
  S.usingProxy = true;
  detachAudio(); // preview copies carry their own AAC sound
  const t = video.currentTime || S.start;
  if (S.info.proxy) { setVideoSrc(S.info.proxy, t); return; }
  showStageMsg('Your browser can’t play this format, so GIF Creator is making a preview copy. Exports still use the original file.');
  try {
    const job = await api('/api/proxy', { json: { path } });
    trackJob(job, {
      onProgress(j) { if (S.info?.path === path) showStageMsg(`Making a preview copy: ${Math.round((j.progress || 0) * 100)}%`); },
      onDone(j) { if (S.info?.path === path) { S.info.proxy = j.result.path; hideStageMsg(); setVideoSrc(j.result.path, t); } },
      onError(j) { if (S.info?.path === path) showStageMsg(`Couldn't make a preview copy: ${j.error}`); },
    });
  } catch (err) {
    showStageMsg(err.message);
  }
}

function showStageMsg(msg) { const el = $('#stage-msg'); el.textContent = msg; el.hidden = false; }
function hideStageMsg() { $('#stage-msg').hidden = true; }

// ================================================================ sound for audio formats browsers can't play

async function useExternalAudio() {
  const info = S.info;
  if (!info || info.audio_index == null || S.extAudio || S.audioJobFor === info.path) return;
  if (info.preview_audio) { attachAudio(info.preview_audio); return; }
  S.audioJobFor = info.path;
  try {
    const job = await api('/api/preview-audio', { json: { path: info.path } });
    trackJob(job, {
      onProgress(j) { if (S.info === info) showStageMsg(`Converting this video’s sound so it plays here: ${Math.round((j.progress || 0) * 100)}%`); },
      onDone(j) { if (S.info === info) { info.preview_audio = j.result.path; hideStageMsg(); attachAudio(j.result.path); } },
      onError(j) { if (S.info === info) { S.audioJobFor = null; showStageMsg(`Couldn’t convert the sound: ${j.error}`); } },
    });
  } catch (err) {
    S.audioJobFor = null;
    toast(err.message, { error: true });
  }
}

function attachAudio(src) {
  S.extAudio = true;
  audio.src = mediaUrl(src);
  audio.playbackRate = video.playbackRate;
  applyMute();
}

function detachAudio() {
  S.extAudio = false;
  S.audioJobFor = null;
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
  applyMute();
}

function applyMute() {
  video.muted = S.extAudio || S.settings.muted;
  audio.muted = S.settings.muted;
}

let audioSyncedAt = 0;
let seekLead = 0.15; // sound takes a moment to resume after a jump, so start it this far ahead
let leadCheck;
function syncAudio(force = false) {
  if (!S.extAudio || audio.readyState < 1) return;
  const drift = audio.currentTime - video.currentTime; // positive: sound is ahead
  if (force || Math.abs(drift) > 0.5) {
    const playing = !video.paused;
    audio.currentTime = video.currentTime + (playing ? seekLead * video.playbackRate : 0);
    audio.playbackRate = video.playbackRate;
    clearTimeout(leadCheck);
    if (playing) {
      // Learn this machine's resume delay from how far off the jump landed.
      leadCheck = setTimeout(() => {
        if (S.extAudio && !video.paused) seekLead = clamp(seekLead - (audio.currentTime - video.currentTime) * 0.7, 0, 0.4);
      }, 700);
    }
    return;
  }
  const now = performance.now();
  if (now - audioSyncedAt < 100) return;
  audioSyncedAt = now;
  // Close small gaps by briefly speeding up or slowing the sound; a jump would be audible.
  const nudge = Math.abs(drift) < 0.03 ? 0 : clamp(-drift * 0.6, -0.1, 0.1);
  audio.playbackRate = video.playbackRate * (1 + nudge);
}

const playAudio = () => {
  if (!S.extAudio || video.paused) return;
  syncAudio(true); // starting playback has the same delay as a jump, so give it the same head start
  audio.play().catch(() => {});
};
audio.addEventListener('loadedmetadata', playAudio);
video.addEventListener('playing', playAudio);
video.addEventListener('pause', () => audio.pause());
video.addEventListener('waiting', () => audio.pause());
video.addEventListener('seeking', () => syncAudio(true));
video.addEventListener('ratechange', () => { audio.playbackRate = video.playbackRate; });

// Chrome reports decoded audio bytes; zero after playing a moment means the track is silent here.
let silentCheck;
video.addEventListener('playing', () => {
  clearTimeout(silentCheck);
  const info = S.info;
  silentCheck = setTimeout(() => {
    if (S.info === info && !S.extAudio && !video.paused && info?.audio_index != null
        && 'webkitAudioDecodedByteCount' in video && video.webkitAudioDecodedByteCount === 0) useExternalAudio();
  }, 1500);
});

// ================================================================ sessions (per-video edits survive reloads)

let sessionTimer;
function saveSession() {
  clearTimeout(sessionTimer);
  if (!S.info) return;
  store(`session:${S.info.path}`, { start: S.start, end: S.end, captions: S.captions, crop: stage.crop, aspect: stage.aspect });
}
const saveSessionSoon = () => { clearTimeout(sessionTimer); sessionTimer = setTimeout(saveSession, 400); };
window.addEventListener('beforeunload', saveSession);

function saveSettings() { store('settings', S.settings); }

// ================================================================ playback

function seek(t) {
  if (!S.info) return;
  t = clamp(t, 0, S.info.duration);
  if (video.readyState >= 1) video.currentTime = t;
  showTime(t);
}

function showTime(t) {
  $('#tc-now').textContent = fmtTime(t);
  timeline.setTime(t);
  stage.setTime(t);
}

function togglePlay() {
  if (!S.info) return;
  if (video.paused) {
    const t = video.currentTime;
    if ($('#loop-play').checked && (t < S.start - 0.05 || t >= S.end - 0.05)) video.currentTime = S.start;
    video.play().catch(() => {});
  } else {
    video.pause();
  }
}

function tick() {
  if (S.info && !video.paused) {
    let t = video.currentTime;
    if ($('#loop-play').checked && t >= S.end) {
      video.currentTime = S.start;
      t = S.start;
    }
    showTime(t);
    syncAudio();
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

video.addEventListener('play', () => { $('#play').classList.add('playing'); $('#play').setAttribute('aria-label', 'Pause'); });
video.addEventListener('pause', () => { $('#play').classList.remove('playing'); $('#play').setAttribute('aria-label', 'Play'); });
video.addEventListener('seeked', () => { if (video.paused) showTime(video.currentTime); });

const frameStep = () => 1 / (S.info?.fps || 30);
$('#play').addEventListener('click', togglePlay);
$('#step-back').addEventListener('click', () => { video.pause(); seek(video.currentTime - frameStep()); });
$('#step-fwd').addEventListener('click', () => { video.pause(); seek(video.currentTime + frameStep()); });
$('#set-in').addEventListener('click', setInAtPlayhead);
$('#set-out').addEventListener('click', setOutAtPlayhead);
$('#zoom-clip').addEventListener('click', () => timeline.zoomToClip());
$('#zoom-fit').addEventListener('click', () => timeline.fit());
$('#mute').checked = S.settings.muted;
$('#mute').addEventListener('change', (e) => { S.settings.muted = e.target.checked; applyMute(); saveSettings(); });

function setRange(start, end) {
  S.start = start;
  S.end = end;
  timeline.setRange(start, end);
  syncClipInputs();
  updateEstimate();
  saveSessionSoon();
}

function setInAtPlayhead() {
  if (!S.info) return;
  const t = video.currentTime;
  const len = S.end - S.start;
  if (t >= S.end - 0.1) setRange(t, Math.min(S.info.duration, t + len));
  else setRange(t, S.end);
}

function setOutAtPlayhead() {
  if (!S.info) return;
  const t = video.currentTime;
  const len = S.end - S.start;
  if (t <= S.start + 0.1) setRange(Math.max(0, t - len), Math.max(t, 0.1));
  else setRange(S.start, t);
}

// ================================================================ clip panel

function syncClipInputs() {
  $('#clip-start').value = fmtTime(S.start);
  $('#clip-end').value = fmtTime(S.end);
  $('#clip-len').value = (S.end - S.start).toFixed(2);
}

function onTimeField(id, apply) {
  $(id).addEventListener('change', (e) => {
    const v = parseTime(e.target.value);
    if (Number.isNaN(v)) { toast('Use seconds (12.5) or minutes:seconds (1:12.5).', { error: true }); syncClipInputs(); return; }
    apply(v);
  });
}
onTimeField('#clip-start', (v) => { const s = clamp(v, 0, S.info.duration - 0.1); setRange(s, Math.max(S.end, s + 0.1)); seek(s); });
onTimeField('#clip-end', (v) => { const e = clamp(v, 0.1, S.info.duration); setRange(Math.min(S.start, e - 0.1), e); seek(e); });
onTimeField('#clip-len', (v) => { setRange(S.start, clamp(S.start + Math.max(v, 0.1), 0.1, S.info.duration)); });

$('#speed').addEventListener('change', (e) => { S.settings.speed = parseFloat(e.target.value); video.playbackRate = S.settings.speed; saveSettings(); updateEstimate(); });
$('#boomerang').addEventListener('change', (e) => { S.settings.boomerang = e.target.checked; saveSettings(); updateEstimate(); });

// ================================================================ crop panel

function syncAspectButtons(aspect) {
  $$('#aspect button').forEach((b) => b.setAttribute('aria-pressed', String(String(aspect) === b.dataset.aspect || (typeof aspect === 'number' && Math.abs(aspect - parseFloat(b.dataset.aspect)) < 0.001))));
}
$$('#aspect button').forEach((b) => b.addEventListener('click', () => {
  const a = b.dataset.aspect;
  const aspect = a === 'full' || a === 'free' ? a : parseFloat(a);
  syncAspectButtons(aspect);
  stage.setAspect(aspect);
}));

function renderCropHint() {
  if (!S.info) return;
  $('#crop-hint').textContent = stage.isFull()
    ? 'Drag the edges of the video to crop.'
    : `Cropped to ${S.crop.w} × ${S.crop.h} px. Drag inside the box to move it.`;
}

// ================================================================ text panel

const fontSelect = $('#cap-font');
for (const f of FONTS) {
  const o = document.createElement('option');
  o.value = f.name;
  o.textContent = f.name;
  o.style.fontFamily = `"${f.name}"`;
  fontSelect.append(o);
}

const selected = () => S.captions.find((c) => c.id === S.selectedId);

function renderCaptions() {
  const list = $('#cap-list');
  list.replaceChildren(...S.captions
    .slice().sort((a, b) => a.start - b.start)
    .map((c) => {
      const li = document.createElement('li');
      li.className = 'cap-item';
      li.setAttribute('aria-selected', String(c.id === S.selectedId));
      li.innerHTML = '<span class="txt"></span><span class="when"></span>';
      li.querySelector('.txt').textContent = c.text || 'Empty text';
      li.querySelector('.when').textContent = `${fmtTime(c.start)} to ${fmtTime(c.end)}`;
      li.addEventListener('click', () => {
        selectCaption(c.id);
        const t = video.currentTime;
        if (t < c.start || t >= c.end) { video.pause(); seek(c.start + 0.01); }
      });
      return li;
    }));
  $('#cap-empty').hidden = S.captions.length > 0;
  timeline.setCaptions(S.captions, S.selectedId);
  stage.setCaptions(S.captions, S.selectedId);
}

function selectCaption(id) {
  S.selectedId = id;
  renderCaptions();
  fillEditor();
}

function fillEditorTimes() {
  const c = selected();
  if (!c) return;
  $('#cap-start').value = fmtTime(c.start);
  $('#cap-end').value = fmtTime(c.end);
}

function fillEditor() {
  const c = selected();
  $('#cap-editor').hidden = !c;
  if (!c) return;
  if (document.activeElement !== $('#cap-text')) $('#cap-text').value = c.text;
  fillEditorTimes();
  fontSelect.value = c.font;
  $('#cap-size').value = c.size;
  $('#cap-color').value = c.color;
  $('#cap-stroke').value = c.stroke;
  $('#cap-stroke-w').value = c.strokeW;
  $('#cap-box').checked = c.box;
  $('#cap-upper').checked = c.upper;
  $$('#cap-presets button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.preset === c.preset)));
  $$('#cap-align button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.align === c.align)));
}

function addCaption() {
  if (!S.info) return;
  const t = video.currentTime;
  const start = t >= S.start && t < S.end - 0.2 ? t : S.start;
  const cap = newCaption({ preset: S.settings.preset, start, end: S.end });
  S.captions.push(cap);
  if (t < start || t >= cap.end) seek(start + 0.01);
  selectCaption(cap.id);
  $('#cap-text').focus();
  saveSessionSoon();
}

function updateSelected(mutate, { full = false } = {}) {
  const c = selected();
  if (!c) return;
  mutate(c);
  if (full) { renderCaptions(); fillEditor(); } else { stage.draw(); timeline.setCaptions(S.captions, S.selectedId); }
  saveSessionSoon();
}

$('#add-cap').addEventListener('click', addCaption);
$('#cap-text').addEventListener('input', (e) => {
  updateSelected((c) => { c.text = e.target.value; });
  const row = $('#cap-list .cap-item[aria-selected=true] .txt');
  if (row) row.textContent = e.target.value || 'Empty text';
});
$('#cap-text').addEventListener('change', () => renderCaptions());
$('#cap-size').addEventListener('input', (e) => updateSelected((c) => { c.size = parseFloat(e.target.value); }));
$('#cap-color').addEventListener('input', (e) => updateSelected((c) => { c.color = e.target.value; }));
$('#cap-stroke').addEventListener('input', (e) => updateSelected((c) => { c.stroke = e.target.value; }));
$('#cap-stroke-w').addEventListener('input', (e) => updateSelected((c) => { c.strokeW = parseFloat(e.target.value); }));
$('#cap-box').addEventListener('change', (e) => updateSelected((c) => { c.box = e.target.checked; }));
$('#cap-upper').addEventListener('change', (e) => updateSelected((c) => { c.upper = e.target.checked; }));
fontSelect.addEventListener('change', (e) => updateSelected((c) => {
  c.font = e.target.value;
  c.weight = FONTS.find((f) => f.name === c.font)?.weight ?? 700;
}));
$$('#cap-presets button').forEach((b) => b.addEventListener('click', () => updateSelected((c) => {
  applyPreset(c, b.dataset.preset);
  S.settings.preset = b.dataset.preset;
  saveSettings();
}, { full: true })));
$$('#cap-align button').forEach((b) => b.addEventListener('click', () => updateSelected((c) => {
  c.align = b.dataset.align;
  c.x = 0.5;
  c.y = ALIGN_Y[c.align];
}, { full: true })));

function capTimeField(id, key) {
  $(id).addEventListener('change', (e) => {
    const v = parseTime(e.target.value);
    if (Number.isNaN(v)) { fillEditorTimes(); return; }
    updateSelected((c) => {
      if (key === 'start') { c.start = clamp(v, 0, S.info.duration - 0.1); c.end = Math.max(c.end, c.start + 0.1); }
      else { c.end = clamp(v, 0.1, S.info.duration); c.start = Math.min(c.start, c.end - 0.1); }
    }, { full: true });
  });
}
capTimeField('#cap-start', 'start');
capTimeField('#cap-end', 'end');
$('#cap-start-now').addEventListener('click', () => updateSelected((c) => { c.start = Math.min(video.currentTime, c.end - 0.1); }, { full: true }));
$('#cap-end-now').addEventListener('click', () => updateSelected((c) => { c.end = Math.max(video.currentTime, c.start + 0.1); }, { full: true }));

function deleteSelected() {
  if (!S.selectedId) return;
  S.captions = S.captions.filter((c) => c.id !== S.selectedId);
  S.selectedId = null;
  renderCaptions();
  fillEditor();
  saveSessionSoon();
}
$('#cap-delete').addEventListener('click', deleteSelected);

// subtitles
async function loadSubSources(selectId) {
  const { sources } = await api(`/api/subs?path=${enc(S.info.path)}`);
  const sel = $('#subs-source');
  sel.replaceChildren(...sources.map((s) => Object.assign(document.createElement('option'), { value: s.id, textContent: s.label })));
  if (!sources.length) {
    sel.append(Object.assign(document.createElement('option'), { value: '', textContent: 'None next to this video', disabled: true, selected: true }));
  }
  if (selectId) sel.value = selectId;
  $('#subs-go').disabled = !sources.length;
}

$('#import-subs').addEventListener('click', async () => {
  if (!S.info) return;
  const picker = $('#subs-picker');
  if (!picker.hidden) { picker.hidden = true; return; }
  try {
    await loadSubSources();
    picker.hidden = false;
  } catch (err) { toast(err.message, { error: true }); }
});

$('#subs-choose').addEventListener('click', async () => {
  try {
    const r = await api('/api/subs/choose', { json: {} });
    if (!r.canceled) await loadSubSources(r.id);
  } catch (err) { toast(err.message, { error: true }); }
});

$('#subs-go').addEventListener('click', async () => {
  const offset = parseFloat($('#subs-offset').value.trim() || '0');
  if (!Number.isFinite(offset)) {
    toast('Enter the shift in seconds, like 0.7 or -1.5.', { error: true });
    return;
  }
  try {
    const { cues } = await api(`/api/subs/cues?path=${enc(S.info.path)}&source=${enc($('#subs-source').value)}`);
    const inClip = cues
      .map((c) => ({ ...c, start: c.start + offset, end: c.end + offset }))
      .filter((c) => c.end > S.start && c.start < S.end);
    if (!inClip.length) {
      toast(`No subtitle lines fall between ${fmtTime(S.start)} and ${fmtTime(S.end)}.`);
      return;
    }
    for (const c of inClip) {
      S.captions.push(newCaption({ preset: 'subtitle', text: c.text, start: Math.max(c.start, S.start), end: Math.min(c.end, S.end) }));
    }
    $('#subs-picker').hidden = true;
    renderCaptions();
    saveSessionSoon();
    toast(`Added ${inClip.length} subtitle line${inClip.length === 1 ? '' : 's'}.`);
  } catch (err) { toast(err.message, { error: true }); }
});

// ================================================================ output panel

function outDims() {
  const c = S.crop || { w: S.info.width, h: S.info.height };
  let w = S.settings.width ? Math.min(S.settings.width, c.w) : c.w;
  w = Math.max(16, Math.round(w / 2) * 2);
  const h = Math.max(16, Math.round((w * c.h) / c.w / 2) * 2);
  return { w, h };
}

function updateEstimate() {
  if (!S.info) return;
  const { w, h } = outDims();
  const secs = ((S.end - S.start) / S.settings.speed) * (S.settings.boomerang ? 2 : 1);
  const frames = Math.round(secs * S.settings.fps);
  let text = `${w} × ${h} px, ${secs.toFixed(1)} s, ${frames} frames`;
  if (S.settings.format === 'gif' && w * h * frames * 0.3 > 15e6) text += '. This will be a large GIF; a smaller width or frame rate helps.';
  $('#estimate').textContent = text;
  $('#export-btn').textContent = `Export ${S.settings.format.toUpperCase()}`;
}

function syncOutputControls() {
  const st = S.settings;
  $$('#format button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.format === st.format)));
  $$('.gif-only').forEach((el) => { el.hidden = st.format !== 'gif'; });
  $$('.not-mp4').forEach((el) => { el.hidden = st.format === 'mp4'; });
  $$('.mp4-only').forEach((el) => { el.hidden = st.format !== 'mp4'; });
  $('#sound-out').checked = st.sound;
  $('#out-width').value = String(st.width);
  $('#fps').value = String(st.fps);
  $('#colors').value = String(st.colors);
  $('#dither').value = st.dither;
  $('#loop-out').checked = st.loop;
  $('#speed').value = String(st.speed);
  $('#boomerang').checked = st.boomerang;
}

$$('#format button').forEach((b) => b.addEventListener('click', () => {
  S.settings.format = b.dataset.format;
  saveSettings();
  syncOutputControls();
  updateEstimate();
}));
for (const [id, key, parse] of [['#out-width', 'width', Number], ['#fps', 'fps', Number], ['#colors', 'colors', Number], ['#dither', 'dither', String]]) {
  $(id).addEventListener('change', (e) => { S.settings[key] = parse(e.target.value); saveSettings(); updateEstimate(); });
}
$('#loop-out').addEventListener('change', (e) => { S.settings.loop = e.target.checked; saveSettings(); });
$('#sound-out').addEventListener('change', (e) => { S.settings.sound = e.target.checked; saveSettings(); });

// ================================================================ export

async function doExport() {
  if (!S.info || S.exportJobId) return;
  const { w, h } = outDims();
  const caps = S.captions.filter((c) => c.text.trim() && c.end > S.start && c.start < S.end);
  await Promise.all(caps.map((c) => document.fonts.load(`${c.weight} 40px "${c.font}"`).catch(() => {})));
  const st = S.settings;
  const req = {
    path: S.info.path, start: S.start, end: S.end, crop: stage.isFull() ? null : S.crop,
    out_w: w, out_h: h, fps: st.fps, speed: st.speed, boomerang: st.boomerang,
    format: st.format, colors: st.colors, dither: st.dither, loop: st.loop,
    sound: st.sound && S.info.audio_index != null,
    captions: caps.map((c) => ({ start: c.start, end: c.end, png: captionPNG(c, w, h) })),
  };
  setExporting(true);
  try {
    const job = await api('/api/export', { json: req });
    S.exportJobId = job.id;
    trackJob(job, {
      onProgress: renderExportProgress,
      onDone(j) { setExporting(false); showResult(j.result); refreshLibrary(); },
      onError(j) { setExporting(false); toast(`Export failed: ${j.error}`, { error: true }); },
      onCancel() { setExporting(false); },
    });
  } catch (err) {
    setExporting(false);
    toast(err.message, { error: true });
  }
}

function setExporting(on) {
  if (!on) S.exportJobId = null;
  $('#export-btn').hidden = on;
  $('#export-progress').hidden = !on;
  if (on) { $('#result').hidden = true; renderExportProgress({ progress: 0, message: 'Starting' }); }
}

function renderExportProgress(j) {
  const el = $('#export-progress');
  el.classList.toggle('indeterminate', j.progress == null);
  el.querySelector('.bar').style.width = `${(j.progress || 0) * 100}%`;
  el.querySelector('.p-label').textContent = `${j.message || 'Working'}${j.progress != null ? ` ${Math.round(j.progress * 100)}%` : ''}`;
}

function showResult(r) {
  S.lastResult = r;
  const media = $('#result .result-media');
  const src = `${mediaUrl(r.path)}&v=${Date.now()}`;
  media.innerHTML = r.name.endsWith('.mp4')
    ? `<video src="${src}" autoplay loop muted playsinline${r.sound ? ' title="Click to hear it"' : ''}></video>`
    : `<img src="${src}" alt="Exported animation">`;
  if (r.sound) media.querySelector('video').addEventListener('click', (e) => { e.target.muted = !e.target.muted; });
  $('#result .result-meta').innerHTML = '<strong></strong><span></span>';
  $('#result .result-meta strong').textContent = r.name;
  $('#result .result-meta span').textContent = r.kind === 'frame'
    ? `${fmtBytes(r.size)}, ${r.width} × ${r.height}, frame at ${fmtTime(r.time)}`
    : `${fmtBytes(r.size)}, ${r.width} × ${r.height}, ${r.frames} frames${r.sound ? ', with sound' : ''}`;
  $('#result').hidden = false;
}

// ================================================================ still frames

async function saveFrame() {
  if (!S.info || S.savingFrame) return;
  video.pause();
  const t = video.currentTime;
  const crop = stage.isFull() ? null : S.crop;
  const W = crop ? crop.w : S.info.width;
  const H = crop ? crop.h : S.info.height;
  const visible = S.captions.filter((c) => c.text.trim() && isVisibleAt(c, t));
  let captions = null;
  if (visible.length) {
    await Promise.all(visible.map((c) => document.fonts.load(`${c.weight} 40px "${c.font}"`).catch(() => {})));
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    visible.forEach((c) => drawCaption(ctx, c, W, H));
    captions = canvas.toDataURL('image/png');
  }
  S.savingFrame = true;
  $('#save-frame').disabled = true;
  try {
    const r = await api('/api/frame', { json: { path: S.info.path, time: t, crop, captions } });
    showResult(r);
    refreshLibrary();
    toast(`Saved the frame at ${fmtTime(t)} to your exports.`);
  } catch (err) {
    toast(`Couldn't save the frame: ${err.message}`, { error: true });
  } finally {
    S.savingFrame = false;
    $('#save-frame').disabled = false;
  }
}

$('#save-frame').addEventListener('click', saveFrame);
$('#export-btn').addEventListener('click', doExport);
$('#export-cancel').addEventListener('click', () => { if (S.exportJobId) api('/api/cancel', { json: { id: S.exportJobId } }); });
$('#res-copy').addEventListener('click', () => S.lastResult && copyFile(S.lastResult.path));
$('#res-reveal').addEventListener('click', () => S.lastResult && reveal(S.lastResult.path));

// ================================================================ keyboard

document.addEventListener('keydown', (e) => {
  const typing = e.target.closest('input, textarea, select, [contenteditable]');
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'e') { e.preventDefault(); doExport(); return; }
  if (e.key === 'Escape') {
    toggleOptions(false);
    if (typing) e.target.blur();
    else if (S.selectedId) selectCaption(null);
    return;
  }
  if (typing || e.metaKey || e.ctrlKey || e.altKey || !S.info) return;
  const k = e.key;
  if (k === ' ') { e.preventDefault(); togglePlay(); }
  else if (k === 'ArrowLeft' || k === 'ArrowRight') {
    e.preventDefault();
    video.pause();
    seek(video.currentTime + (k === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 1 : frameStep()));
  }
  else if (k === 'i' || k === 'I') setInAtPlayhead();
  else if (k === 'o' || k === 'O') setOutAtPlayhead();
  else if (k === 't' || k === 'T') { e.preventDefault(); addCaption(); }
  else if (k === 'f' || k === 'F') saveFrame();
  else if (k === '[') seek(S.start);
  else if (k === ']') seek(S.end);
  else if (k === 'Backspace' || k === 'Delete') { if (S.selectedId) { e.preventDefault(); deleteSelected(); } }
});

// ================================================================ boot

$$('.tab').forEach((t) => t.addEventListener('click', () => setTab(t.dataset.tab)));
$('#lib-search').addEventListener('input', (e) => { S.filter = e.target.value; renderLibrary(); });
$('#open-exports').addEventListener('click', () => api('/api/open-folder', { json: { folder: 'exports' } }));
window.addEventListener('focus', refreshLibrary);

syncOutputControls();
refreshLibrary();
api('/api/jobs').then(({ jobs }) => {
  for (const j of jobs) {
    if (j.status === 'running' && j.kind === 'download') {
      trackJob(j, { list: true, onDone: () => refreshLibrary(), onError: (x) => toast(`Download failed: ${x.error}`, { error: true }) });
    }
  }
}).catch(() => {});
