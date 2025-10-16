// ui.js — uploader + controls bindings
// ------------------------------------------------------------
import { createState } from './state.js';
import { Renderer } from './renderer.js';
import { Exporter } from './exporter.js';

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

  // --- Uploader
  els.pickBtn.onclick = ()=> els.fileInput.click();
  els.fileInput.onchange = ()=> addFiles(els.fileInput.files);
  ['dragover','dragenter'].forEach(ev=> els.drop.addEventListener(ev, e=>{ e.preventDefault(); els.drop.style.borderColor = '#3b82f6'; }));
  ['dragleave','drop'].forEach(ev=> els.drop.addEventListener(ev, e=>{ e.preventDefault(); els.drop.style.borderColor = '#3a3a3a'; }));
  els.drop.addEventListener('drop', e=> addFiles(e.dataTransfer.files));

  function addFiles(files){
    const list = Array.from(files||[]).filter(f=> f.type && f.type.startsWith('image/'));
    list.forEach(f=> {
      const url = URL.createObjectURL(f);
      const img = new Image();
      img.src = url;
      state.slides.push({ file:f, url, img });
    });
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
