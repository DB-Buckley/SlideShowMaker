// ui.js — uploader + controls with auto-rotate, duplicate removal, manual rotation, drag-to-reposition
import { createState } from './state.js';
import { Renderer } from './renderer.js';
import { Exporter } from './exporter.js';
import { readExifOrientation, drawWithOrientation } from './exif.js';
import { sha256Hex, aHashFromCanvas, hammingDistance64 } from './hash.js';

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
    adjustBtn: document.getElementById('adjustBtn'),
    seek: document.getElementById('seek'),
    currTime: document.getElementById('currTime'),
    totalTime: document.getElementById('totalTime'),
    exportBtn: document.getElementById('exportBtn'),
    progBar: document.getElementById('progBar'),
    dlArea: document.getElementById('dlArea'),
    // These may not exist yet; we create/rebind below:
    autoMp4: document.getElementById('autoMp4'),
    convertBtn: document.getElementById('convertBtn'),
  };

  // Ensure Export controls exist even if HTML doesn't include them
  function ensureExportControls(){
    const prog = document.getElementById('progBar');
    if (!prog) return;
    const exportBd = prog.closest('.bd') || prog.parentElement;

    // Find/create the export bar (the row with the export button)
    let exportBar = exportBd.querySelector('.bar');
    if (!exportBar){
      exportBar = document.createElement('div');
      exportBar.className = 'bar';
      exportBd.appendChild(exportBar);
    }

    // Export button
    if (!document.getElementById('exportBtn')){
      const exportBtn = document.createElement('button');
      exportBtn.id = 'exportBtn';
      exportBtn.className = 'btn';
      exportBtn.textContent = 'Export (WebM)';
      exportBar.appendChild(exportBtn);
    }

    // Auto-convert checkbox
    if (!document.getElementById('autoMp4')){
      const wrap = document.createElement('label');
      wrap.className = 'bar';
      wrap.style.gap = '8px';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.id = 'autoMp4';
      const span = document.createElement('span');
      span.textContent = 'Auto-convert to MP4 (slower)';
      wrap.appendChild(cb); wrap.appendChild(span);
      exportBar.appendChild(wrap);
    }

    // Convert button
    if (!document.getElementById('convertBtn')){
      const convertBtn = document.createElement('button');
      convertBtn.id = 'convertBtn';
      convertBtn.className = 'btn ghost';
      convertBtn.textContent = 'Convert last WebM → MP4';
      convertBtn.disabled = true;
      exportBar.appendChild(convertBtn);
    }

    // Download/status area
    if (!document.getElementById('dlArea')){
      const dl = document.createElement('div');
      dl.id = 'dlArea';
      dl.className = 'help';
      dl.style.marginTop = '8px';
      exportBd.appendChild(dl);
    }
  }
  ensureExportControls();

  // Rebind any newly created elements
  els.exportBtn = document.getElementById('exportBtn');
  els.autoMp4 = document.getElementById('autoMp4');
  els.convertBtn = document.getElementById('convertBtn');
  els.dlArea = document.getElementById('dlArea');

  const state = createState();
  const renderer = new Renderer(els.canvas, state);
  const exporter = new Exporter(els.canvas, renderer, state, els);

  // duplicate tracking
  const exactHashes = new Set();           // SHA-256 of file bytes
  const perceptual = [];                   // {hash:BigInt, idx:number}
  const PHASH_THRESHOLD = 5n;              // <=5 bits → near duplicate

  function toast(msg){
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    document.body.appendChild(t);
    requestAnimationFrame(()=> t.classList.add('show'));
    setTimeout(()=>{ t.classList.remove('show'); setTimeout(()=> t.remove(), 300); }, 2200);
  }

  // --- Uploader
  if (els.pickBtn) els.pickBtn.onclick = ()=> els.fileInput && els.fileInput.click();
  if (els.fileInput) els.fileInput.onchange = ()=> addFiles(els.fileInput.files);
  ['dragover','dragenter'].forEach(ev=> els.drop && els.drop.addEventListener(ev, e=>{ e.preventDefault(); els.drop.style.borderColor = '#3b82f6'; }));
  ['dragleave','drop'].forEach(ev=> els.drop && els.drop.addEventListener(ev, e=>{ e.preventDefault(); els.drop.style.borderColor = '#3a3a3a'; }));
  els.drop && els.drop.addEventListener('drop', e=> addFiles(e.dataTransfer.files));

  async function addFiles(files){
    const list = Array.from(files||[]).filter(f=> f.type && f.type.startsWith('image/'));
    let skipped = 0, added = 0;

    for (const f of list){
      const fbuf = await f.arrayBuffer();
      const sha = await sha256Hex(fbuf);
      if (exactHashes.has(sha)){ skipped++; continue; }

      const imgUrl = URL.createObjectURL(new Blob([fbuf], { type:f.type }));
      const img = await new Promise((res, rej)=>{
        const im = new Image(); im.onload = ()=> res(im); im.onerror = rej; im.src = imgUrl;
      });

      let orientation = 1;
      try{ orientation = await readExifOrientation(fbuf); }catch{ orientation = 1; }

      const off = document.createElement('canvas');
      off.width = els.canvas.width; off.height = els.canvas.height;
      const octx = off.getContext('2d');
      octx.fillStyle = '#000'; octx.fillRect(0,0,off.width,off.height);
      drawWithOrientation(octx, img, orientation, off.width, off.height);

      const ph = aHashFromCanvas(off);
      const isNearDup = perceptual.some(p=> hammingDistance64(p.hash, ph) <= PHASH_THRESHOLD);
      if (isNearDup){ skipped++; continue; }

      const blob = await new Promise(res=> off.toBlob(res, 'image/jpeg', 0.9));
      const fixedUrl = URL.createObjectURL(blob);
      const fixedImg = await new Promise((res, rej)=>{
        const im = new Image(); im.onload = ()=> res(im); im.onerror = rej; im.src = fixedUrl;
      });

      exactHashes.add(sha);
      perceptual.push({ hash: ph, idx: state.slides.length });

      state.slides.push({ file:f, url: fixedUrl, img: fixedImg, rotation: 0, pan:{x:0,y:0} });
      added++;
    }

    if (skipped) toast(`Skipped ${skipped} duplicate${skipped>1?'s':''}`);
    if (added) toast(`Added ${added} photo${added>1?'s':''}`);

    renderThumbs();
    updateTotal();
    state.emit('slides:changed');
  }

  function renderThumbs(){
    const wrap = els.thumbs; if (!wrap) return; wrap.innerHTML = '';
    state.slides.forEach((s, i)=>{
      const div = document.createElement('div'); div.className='th'; div.draggable=true;
      const im = document.createElement('img'); im.src = s.url; div.appendChild(im);
      const rm = document.createElement('button'); rm.className='rm'; rm.title='Remove'; rm.textContent='×'; div.appendChild(rm);
      const rotL = document.createElement('button'); rotL.className='rot rotL'; rotL.title='Rotate left 90°'; rotL.textContent='⟲'; div.appendChild(rotL);
      const rotR = document.createElement('button'); rotR.className='rot rotR'; rotR.title='Rotate right 90°'; rotR.textContent='⟳'; div.appendChild(rotR);

      im.style.transition = 'transform .2s ease';
      const applyThumbRot = ()=>{ im.style.transform = `rotate(${(state.slides[i].rotation||0)}deg)`; };
      applyThumbRot();
      rotL.onclick = ()=>{ state.slides[i].rotation = ((state.slides[i].rotation||0) - 90) % 360; applyThumbRot(); };
      rotR.onclick = ()=>{ state.slides[i].rotation = ((state.slides[i].rotation||0) + 90) % 360; applyThumbRot(); };

      rm.onclick = ()=>{ state.slides.splice(i,1); renderThumbs(); updateTotal(); };

      div.addEventListener('dragstart', e=> e.dataTransfer.setData('text/plain', i));
      div.addEventListener('dragover', e=> e.preventDefault());
      div.addEventListener('drop', e=>{
        e.preventDefault(); const from = +e.dataTransfer.getData('text/plain'); const to = i;
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
    state.settings.resPreset = els.resPreset?.value || 'sq';
    state.settings.fps = +(els.fps?.value || 30);
    state.settings.holdSec = +(els.holdSec?.value || 2.5);
    state.settings.transitionSec = +(els.transitionSec?.value || 0.6);
    state.settings.motionAmt = +(els.motionAmt?.value || 0.12);
    state.settings.loopPrev = +(els.loopPrev?.value || 1);
    state.settings.bitrate = Math.round(+((els.bitrate?.value)||8)*1_000_000);
    renderer.setRes(state.settings.resPreset);
    updateTotal();
  };
  ['change','input'].forEach(ev=>{
    [els.resPreset, els.fps, els.holdSec, els.transitionSec, els.motionAmt, els.loopPrev, els.bitrate]
      .filter(Boolean)
      .forEach(el=> el.addEventListener(ev, sync));
  });
  const valSync = ()=>{
    if (els.valHold) els.valHold.textContent = state.settings.holdSec.toFixed(1)+'s';
    if (els.valTrans) els.valTrans.textContent = state.settings.transitionSec.toFixed(2)+'s';
    if (els.valMotionAmt) els.valMotionAmt.textContent = state.settings.motionAmt.toFixed(2)+'×';
    if (els.valBitrate) els.valBitrate.textContent = (state.settings.bitrate/1_000_000).toFixed(1)+' Mbps';
  };

  function updateTotal(){
    const total = state.totalDuration(Boolean(state.settings.loopPrev));
    if (els.totalTime) els.totalTime.textContent = fmtTime(total);
    if (els.seek) els.seek.max = String(Math.max(0,total));
    valSync();
    renderer.setRes(state.settings.resPreset);
    if (state.pageCount()) renderer.drawAt(parseFloat(els.seek?.value)||0, Boolean(state.settings.loopPrev));
  }

  // --- Adjust (drag to reposition)
  let adjusting = false;
  if (els.adjustBtn) els.adjustBtn.onclick = ()=>{
    adjusting = !adjusting;
    els.adjustBtn.classList.toggle('primary', adjusting);
    const frame = document.querySelector('.canvasFrame');
    const cnv = els.canvas;
    frame && frame.classList.toggle('adjusting', adjusting);
    cnv && cnv.classList.toggle('adjusting', adjusting);
  };

  // Drag handling on canvas
  let drag = null;
  els.canvas && els.canvas.addEventListener('mousedown', (e)=>{
    if (!adjusting) return;
    e.preventDefault();
    drag = { x:e.offsetX, y:e.offsetY };
  });
  window.addEventListener('mouseup', ()=>{ drag=null; });
  els.canvas && els.canvas.addEventListener('mousemove', (e)=>{
    if (!adjusting || !drag) return;
    const hold = state.settings.holdSec, tr = state.settings.transitionSec, seg = hold+tr;
    // best-effort index from current time in preview
    const t = parseFloat(els.seek?.value)||0;
    let idx = 0;
    if (state.slides.length){
      idx = Math.min(state.slides.length-1, Math.floor(t / seg));
    }
    const slide = state.slides[idx];
    if (!slide) return;

    // compute mid-scale slack based on p=0.5 for consistent feel
    const W = els.canvas.width, H = els.canvas.height;
    const iw = slide.img.naturalWidth || slide.img.width;
    const ih = slide.img.naturalHeight || slide.img.height;
    const cover = Math.max(W/iw, H/ih);
    const startScale = cover * (1 + state.settings.motionAmt);
    const endScale   = cover * (1 - state.settings.motionAmt*0.5);
    const s = startScale + (endScale - startScale) * 0.5;
    const dw = iw * s, dh = ih * s;
    const slackX = Math.max(1, dw - W);
    const slackY = Math.max(1, dh - H);

    const dx = e.offsetX - drag.x;
    const dy = e.offsetY - drag.y;
    drag = { x:e.offsetX, y:e.offsetY };

    slide.pan = slide.pan || {x:0,y:0};
    slide.pan.x = Math.max(-1, Math.min(1, slide.pan.x - (dx*2)/slackX ));
    slide.pan.y = Math.max(-1, Math.min(1, slide.pan.y - (dy*2)/slackY ));

    renderer.drawAt(t, Boolean(state.settings.loopPrev));
  });

  // --- Transport
  let playing = false;
  let start = 0;
  let baseT = 0;

  function tick(){
    if (!playing) return;
    const t = (performance.now()-start)/1000 + baseT;
    renderer.drawAt(t, Boolean(state.settings.loopPrev));
    if (els.currTime) els.currTime.textContent = fmtTime(t);
    if (els.seek) els.seek.value = String(t);
    requestAnimationFrame(tick);
  }

  if (els.playBtn) els.playBtn.onclick = ()=>{ if (playing) return; playing = true; start = performance.now(); baseT = parseFloat(els.seek?.value)||0; tick(); };
  if (els.pauseBtn) els.pauseBtn.onclick = ()=>{ if (!playing) return; playing = false; const t = (performance.now()-start)/1000 + baseT; if (els.seek) els.seek.value = String(t); if (els.currTime) els.currTime.textContent = fmtTime(t); };
  if (els.stopBtn) els.stopBtn.onclick = ()=>{ playing = false; if (els.seek) els.seek.value = '0'; renderer.drawAt(0, Boolean(state.settings.loopPrev)); if (els.currTime) els.currTime.textContent = '00:00'; };
  els.seek && els.seek.addEventListener('input', ()=>{ if (!playing) renderer.drawAt(parseFloat(els.seek.value)||0, Boolean(state.settings.loopPrev)); if (els.currTime) els.currTime.textContent = fmtTime(parseFloat(els.seek.value)||0); });

  // --- Export
  let lastWebM = null;

  if (els.convertBtn) els.convertBtn.onclick = async ()=>{
    if (!lastWebM){
      if (els.dlArea) els.dlArea.innerHTML = 'Convert: export a WebM first.';
      return;
    }
    els.convertBtn.disabled = true;
    if (els.dlArea) els.dlArea.innerHTML = 'Converting to MP4… (first run downloads ffmpeg.wasm; may take a moment)';
    try{
      const mp4 = await exporter.convertWebMtoMP4(lastWebM, p=>{
        if (p && typeof p.ratio === 'number' && els.progBar){
          els.progBar.style.width = Math.min(100, Math.round(p.ratio*100)) + '%';
        }
      });
      if (els.progBar) els.progBar.style.width = '100%';
      await exporter._download(mp4, 'slideshow-' + new Date().toISOString().slice(0,19).replace(/[:T]/g,'-') + '.mp4');
      if (els.dlArea) els.dlArea.innerHTML = 'MP4 saved.';
    }catch(e){
      console.error(e);
      if (els.dlArea) els.dlArea.innerHTML = '<b>MP4 conversion failed:</b> ' + (e?.message || e);
    }finally{
      els.convertBtn.disabled = false;
    }
  };

  if (els.exportBtn) els.exportBtn.onclick = async ()=>{
    if (els.progBar) els.progBar.style.width = '0%';
    const toDisable = [els.exportBtn, els.playBtn, els.pauseBtn, els.stopBtn, els.adjustBtn, els.convertBtn].filter(Boolean);
    toDisable.forEach(b=> b.disabled = true);

    try{
      const webm = await exporter.exportWebM();
      lastWebM = webm;
      if (els.dlArea) els.dlArea.innerHTML = 'WebM export complete.';
      if (els.convertBtn) els.convertBtn.disabled = false;

      if (els.autoMp4 && els.autoMp4.checked){
        if (els.dlArea) els.dlArea.innerHTML = 'WebM saved. Converting to MP4… (first run downloads ffmpeg.wasm)';
        const mp4 = await exporter.convertWebMtoMP4(webm, p=>{
          if (p && typeof p.ratio === 'number' && els.progBar){
            els.progBar.style.width = Math.min(100, Math.round(p.ratio*100)) + '%';
          }
        });
        if (els.progBar) els.progBar.style.width = '100%';
        await exporter._download(mp4, 'slideshow-' + new Date().toISOString().slice(0,19).replace(/[:T]/g,'-') + '.mp4');
        if (els.dlArea) els.dlArea.innerHTML = 'WebM + MP4 saved.';
      }else{
        if (els.dlArea) els.dlArea.innerHTML += ' You can convert to MP4 anytime.';
      }
    }catch(e){
      console.error(e);
      if (els.dlArea) els.dlArea.innerHTML = '<b>Export failed:</b> ' + (e?.message || e);
    }finally{
      toDisable.forEach(b=> b.disabled = false);
    }
  };

  // initial
  sync();
  valSync();
  renderer.drawAt(0, true);

  return { state, renderer, exporter, els };
}
