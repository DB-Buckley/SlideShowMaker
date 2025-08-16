// main.js — app bootstrapper (ES module)
// ------------------------------------------------------------
// Wires up state, UI bindings, renderer (preview), and exporter.
// Features implemented across modules:
//  - Continuous motion (zoom/pan) that does not reset on transitions
//  - Randomisation with seed + reshuffle to lock sequences
//  - Multiple layouts (fixed, random pool, playlist per page)
//  - Filters (combinable) per page
//  - Dark/Light theme toggle
//  - Export (WebM in browser). MP4 will be done in Electron via ffmpeg.

import { createState } from './state.js';
import { bindControls, bindUploader, updateInfoPills, updateSeekUI, setThemeFromToggle } from './ui.js';
import { Renderer } from './renderer.js';
import { Exporter } from './exporter.js';

// Grab frequently used DOM elements once
const els = {
  // Pills
  infoCount: document.getElementById('infoCount'),
  infoPages: document.getElementById('infoPages'),
  infoDur: document.getElementById('infoDur'),
  infoRes: document.getElementById('infoRes'),

  // Theme
  themeToggle: document.getElementById('themeToggle'),

  // Canvas
  canvas: document.getElementById('stage'),

  // Transport
  playBtn: document.getElementById('playBtn'),
  pauseBtn: document.getElementById('pauseBtn'),
  stopBtn: document.getElementById('stopBtn'),
  seek: document.getElementById('seek'),
  currTime: document.getElementById('currTime'),
  totalTime: document.getElementById('totalTime'),

  // Export
  exportBtn: document.getElementById('exportBtn'),
  progBar: document.getElementById('progBar'),
  status: document.getElementById('status'),
};

// ------------------------------------------------------------
// App bootstrap
// ------------------------------------------------------------
const state = createState();
const renderer = new Renderer(els.canvas, state);
const exporter = new Exporter(els.canvas, renderer, state, els);

// UI bindings
bindUploader(state, renderer, els);     // drag/drop + thumbs reorder/delete
bindControls(state, renderer, exporter, els); // all selects/sliders/toggles

// Theme boot
setThemeFromToggle(els.themeToggle);

// Initial draw
renderer.resizeToPreset(state.settings.resKey);
renderer.drawAt(0, /*loop*/ false);
updateInfoPills(state, els);
updateSeekUI(state, els, 0);

// ------------------------------------------------------------
// Playback loop (global continuous clock)
// ------------------------------------------------------------
let playing = false;
let t = 0;       // seconds on the global slideshow clock (continuous motion)
let last = 0;    // last rAF timestamp

function raf(ts){
  if (!playing) return;
  if (!last) last = ts;
  const dt = (ts - last) / 1000;
  last = ts;
  t += dt;

  renderer.drawAt(t, /*loop*/ state.settings.loopPreview);
  updateSeekUI(state, els, t);

  requestAnimationFrame(raf);
}

// Transport
els.playBtn.addEventListener('click', ()=>{
  if (!state.pageCount()) { els.status.textContent = 'Add photos to start preview.'; return; }
  if (!playing){ playing = true; last = 0; els.status.textContent = 'Playing preview…'; requestAnimationFrame(raf); }
});
els.pauseBtn.addEventListener('click', ()=>{ playing = false; els.status.textContent = 'Paused.'; });
els.stopBtn.addEventListener('click', ()=>{ playing = false; t = 0; renderer.drawAt(0, false); updateSeekUI(state, els, 0); els.status.textContent = 'Stopped.'; });

// Seek
els.seek.addEventListener('input', ()=>{
  playing = false;
  t = parseFloat(els.seek.value || '0');
  renderer.drawAt(t, /*loop*/ false);
  updateSeekUI(state, els, t);
});

// Keyboard shortcut: Space to play/pause
window.addEventListener('keydown', (e)=>{
  if (e.code === 'Space'){
    e.preventDefault();
    if (playing) els.pauseBtn.click(); else els.playBtn.click();
  }
});

// Export (browser: WebM). In Electron we will invoke ffmpeg for MP4.
els.exportBtn.addEventListener('click', async ()=>{
  try{
    await exporter.exportWebM();
  }catch(err){
    console.error(err);
    els.status.textContent = 'Export failed: ' + err?.message;
  }
});

// ------------------------------------------------------------
// Respond to state changes from UI modules
// ------------------------------------------------------------
// These are called by UI when settings or slides change
state.on('settings:changed', ()=>{
  renderer.resizeToPreset(state.settings.resKey);
  updateInfoPills(state, els);
  if (!playing) renderer.drawAt(t, false);
});

state.on('slides:changed', ()=>{
  updateInfoPills(state, els);
  if (!playing) renderer.drawAt(t, false);
});

state.on('pages:recomputed', ()=>{
  updateInfoPills(state, els);
  // keep current visual if not playing
  if (!playing) renderer.drawAt(t, false);
});

// Expose a tiny debug handle (optional)
window.__SLIDESHOW__ = { state, renderer, exporter };
