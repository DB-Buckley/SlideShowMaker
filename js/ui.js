// ui.js — uploader + controls bindings with auto-rotate + duplicate removal
// ------------------------------------------------------------
import { createState } from './state.js';
import { Renderer } from './renderer.js';
import { Exporter } from './exporter.js';
import { readExifOrientation, drawWithOrientation } from './exif.js';
import { sha256Hex, aHashFromCanvas, hammingDistance64 } from './hash.js';

function clamp(v,min,max){ return Math.max(min, Math.min(max, v)); }
function fmtTime(sec){ if (!isFinite(sec)||sec<=0) return '00:00'; const m=Math.floor(sec/60), s=Math.round(sec%60); return String(m).padStart(2,'0')+':'+String(s).padStart(2,'0'); }

export async function bootstrap(){
  const els = {
    canvas: document.getElementById('stage'),
    pickBtn: document.getElementById('pickBtn'),
    fileInput: document.getElementById('fileInput'),
    drop: document.getElementById('drop'),
    thumbs: document.getElementById('thumbs'),
    resPreset: document.getElementById('resPreset'),
    fps: document.getElementById('fps'),
    holdSec: document.getElementById('holdSec'),
    transitionSec: document.getElementById('transitionSec'),
    motionAmt: document.getElementById('motionAmt'),
    loopPrev: document.getElementById('loopPrev'),
    bitrate: document.getElementById('bitrate'),
    valHold: document.getElementById('valHold'),
    valTrans: document.getElementById('valTrans'),
    valMotionAmt: document.getElementById('valMotionAmt'),
    valBitrate: document.getElementById('valBitrate'),
    playBtn: document.getElementById('playBtn'),
    pauseBtn: document.getElementById('pauseBtn'),
    stopBtn: document.getElementById('stopBtn'),
    seek: document.getElementById('seek'),
    currTime: document.getElementById('currTime'),
    totalTime: document.getElementById('totalTime'),
    exportBtn: document.getElementById('exportBtn'),
    progBar: document.getElementById('progBar'),
  };

  const state = createState();
  const renderer = new Renderer(els.canvas, state);
  const exporter = new Exporter(els.canvas, renderer, state, els);

  // duplicate tracking
  const exactHashes = new Set();     // SHA-256 of file bytes
  const perceptual = [];             // {hash:BigInt, idx:number}
  const PHASH_THRESHOLD = 5n;        // <=5 bits difference → consider duplicate

  // toast helper
  function toast(msg){
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    document.body.appendChild(t);
    requestAnimationFrame(()=> t.classList.add('show'));
    setTimeout(()=>{ t.classList.remove('show'); setTimeout(()=> t.remove(), 300); }, 2200);
  }

  // --- Uploader
  els.pickBtn.onclick = ()=> els.fileInput.click();
  els.fileInput.onchange = ()=> addFiles(els.fileInput.files);
  ['dragover','dragenter'].forEach(ev=> els.drop.addEventListener(ev, e=>{ e.preventDefault(); els.drop.style.borderColor = '#3b82f6'; }));
  ['dragleave','drop'].forEach(ev=> els.drop.addEventListener(ev, e=>{ e.preventDefault(); els.drop.style.borderColor = '#3a3a3a'; }));
  els.drop.addEventListener('drop', e=> addFiles(e.dataTransfer.files));

  async function addFiles(files){
    const list = Array.from(files||[]).filter(f=> f.type && f.type.startsWith('image/'));
    let skipped = 0, added = 0;

    for (const f of list){
      // Exact duplicate (file hash) check
      const fbuf = await f.arrayBuffer();
      const sha = await sha256Hex(fbuf);
      if (exactHashes.has(sha)){ skipped++; continue; }

      // Load image for rotation + perceptual hash
      const imgUrl = URL.createObjectURL(new Blob([fbuf], { type:f.type }));
      const img = await new Promise((res, rej)=>{
        const im = new Image(); im.onload = ()=> res(im); im.onerror = rej; im.src = imgUrl;
      });

      // Read orientation (only meaningful for JPEGs)
      let orientation = 1;
      try{ orientation = await readExifOrientation(fbuf); }catch{ orientation = 1; }

      // Draw corrected onto offscreen canvas at preview/export stage size for consistent hashing
      const off = document.createElement('canvas');
      off.width = els.canvas.width; off.height = els.canvas.height;
      const octx = off.getContext('2d');
      octx.fillStyle = '#000'; octx.fillRect(0,0,off.width,off.height);
      drawWithOrientation(octx, img, orientation, off.width, off.height);

      // Perceptual hash
      const ph = aHashFromCanvas(off);
      // Check similarity with existing perceptual hashes
      const isNearDup = perceptual.some(p=> hammingDistance64(p.hash, ph) <= PHASH_THRESHOLD);
      if (isNearDup){ skipped++; continue; }

      // Convert offscreen to blob for consistent orientation in renderer
      const blob = await new Promise(res=> off.toBlob(res, 'image/jpeg', 0.9));
      const fixedUrl = URL.createObjectURL(blob);
      const fixedImg = await new Promise((res, rej)=>{
        const im = new Image(); im.onload = ()=> res(im); im.onerror = rej; im.src = fixedUrl;
      });

      // Track hashes
      exactHashes.add(sha);
      perceptual.push({ hash: ph, idx: state.slides.length });

      state.slides.push({ file:f, url: fixedUrl, img: fixedImg });
      added++;
    }

    if (skipped) toast(`Skipped ${skipped} duplicate${skipped>1?'s':''}`);
    if (added) toast(`Added ${added} photo${added>1?'s':''}`);

    renderThumbs();
    updateTotal();
    state.emit('slides:changed');
  }

  function renderThumbs(){
    const wrap = els.thumbs; wrap.innerHTML = '';
    state.slides.forEach((s, i)=>{
      const div = document.createElement('div'); div.className='th'; div.draggable=true;
      const im = document.createElement('img'); im.src = s.url; div.appendChild(im);
      const rm = document.createElement('button'); rm.className='rm'; rm.textContent='×'; div.appendChild(rm);
      rm.onclick = ()=>{ state.slides.splice(i,1); renderThumbs(); updateTotal(); };
      div.addEventListener('dragstart', e=> e.dataTransfer.setData('text/plain', i));
      div.addEventListener('dragover', e=> e.preventDefault());
      div.addEventListener('drop', e=>{
        e.preventDefault(); const from = +e.dataTransfer.getData('text/plain');
        const to = i;
        if (from===to) return;
        const [item] = state.slides.splice(from,1);
        state.slides.splice(to,0,item);
        renderThumbs();
      });
      wrap.appendChild(div);
    });
  }

  // --- Controls
  const sync = ()=>{
    state.settings.resPreset = els.resPreset.value;
    state.settings.fps = +els.fps.value;
    state.settings.holdSec = +els.holdSec.value;
    state.settings.transitionSec = +els.transitionSec.value;
    state.settings.motionAmt = +els.motionAmt.value;
    state.settings.loopPrev = +els.loopPrev.value;
    state.settings.bitrate = Math.round(+els.bitrate.value*1_000_000);
    renderer.setRes(state.settings.resPreset);
    updateTotal();
  };
  ['change','input'].forEach(ev=>{
    [els.resPreset, els.fps, els.holdSec, els.transitionSec, els.motionAmt, els.loopPrev, els.bitrate]
      .forEach(el=> el.addEventListener(ev, sync));
  });
  const valSync = ()=>{
    els.valHold.textContent = state.settings.holdSec.toFixed(1)+'s';
    els.valTrans.textContent = state.settings.transitionSec.toFixed(2)+'s';
    els.valMotionAmt.textContent = state.settings.motionAmt.toFixed(2)+'×';
    els.valBitrate.textContent = (state.settings.bitrate/1_000_000).toFixed(1)+' Mbps';
  };

  function updateTotal(){
    const total = state.totalDuration(Boolean(state.settings.loopPrev));
    els.totalTime.textContent = fmtTime(total);
    els.seek.max = String(Math.max(0,total));
    valSync();
    renderer.setRes(state.settings.resPreset);
    if (state.pageCount()) renderer.drawAt(parseFloat(els.seek.value)||0, Boolean(state.settings.loopPrev));
  }

  // --- Preview transport
  let playing = false;
  let start = 0;
  let baseT = 0;

  function tick(){
    if (!playing) return;
    const t = (performance.now()-start)/1000 + baseT;
    renderer.drawAt(t, Boolean(state.settings.loopPrev));
    els.currTime.textContent = fmtTime(t);
    els.seek.value = String(t);
    requestAnimationFrame(tick);
  }

  els.playBtn.onclick = ()=>{
    if (playing) return;
    playing = true;
    start = performance.now();
    baseT = parseFloat(els.seek.value)||0;
    tick();
  };
  els.pauseBtn.onclick = ()=>{
    if (!playing) return;
    playing = false;
    const t = (performance.now()-start)/1000 + baseT;
    els.seek.value = String(t);
    els.currTime.textContent = fmtTime(t);
  };
  els.stopBtn.onclick = ()=>{
    playing = false;
    els.seek.value = '0';
    renderer.drawAt(0, Boolean(state.settings.loopPrev));
    els.currTime.textContent = '00:00';
  };
  els.seek.addEventListener('input', ()=>{
    if (!playing) renderer.drawAt(parseFloat(els.seek.value)||0, Boolean(state.settings.loopPrev));
    els.currTime.textContent = fmtTime(parseFloat(els.seek.value)||0);
  });

  // --- Export
  els.exportBtn.onclick = async ()=>{
    els.progBar.style.width = '0%';
    await exporter.export();
    els.progBar.style.width = '100%';
  };

  // initial
  sync();
  valSync();
  renderer.drawAt(0, true);

  return { state, renderer, exporter, els };
}
