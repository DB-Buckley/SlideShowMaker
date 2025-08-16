// ui.js — binds controls, uploader, theme, and info pills
// -----------------------------------------------------------------------------
// Exports:
//   bindUploader(state, renderer, els)
//   bindControls(state, renderer, exporter, els)
//   updateInfoPills(state, els)
//   updateSeekUI(state, els, t)
//   setThemeFromToggle(toggle)

import { STATE_CONST } from './state.js';

const { LAYOUTS } = STATE_CONST;

function clamp(v,min,max){ return Math.max(min, Math.min(max, v)); }
function fmtTime(sec){ if (!isFinite(sec) || sec <= 0) return '00:00'; const m=Math.floor(sec/60), s=Math.round(sec%60); return String(m).padStart(2,'0')+":"+String(s).padStart(2,'0'); }

// ----------------------------- Uploader & Thumbs -----------------------------
export function bindUploader(state, renderer, els){
  const pickBtn   = document.getElementById('pickBtn');
  const fileInput = document.getElementById('fileInput');
  const drop      = document.getElementById('drop');
  const thumbs    = document.getElementById('thumbs');

  function addFiles(files){
    const list = Array.from(files||[]).filter(f=> f.type && f.type.startsWith('image/'));
    if (!list.length) return;
    let loaded=0; const batch=[];
    els.status && (els.status.textContent = `Loading ${list.length} image${list.length>1?'s':''}…`);
    list.forEach(file=>{
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = ()=>{ batch.push({img, url, name:file.name, w:img.naturalWidth, h:img.naturalHeight}); if(++loaded===list.length){ state.addSlides(batch); if (els.status) els.status.textContent='Ready.'; } };
      img.onerror = ()=>{ if(++loaded===list.length){ state.addSlides(batch); if (els.status) els.status.textContent='Ready (some files failed).'; } };
      img.src = url;
    });
  }

  pickBtn?.addEventListener('click', ()=> fileInput?.click());
  fileInput?.addEventListener('change', e=> addFiles(e.target.files));

  ;['dragenter','dragover'].forEach(ev=> drop?.addEventListener(ev, e=>{ e.preventDefault(); drop.classList.add('drag'); }));
  ;['dragleave','drop'].forEach(ev=> drop?.addEventListener(ev, e=>{ e.preventDefault(); drop.classList.remove('drag'); }));
  drop?.addEventListener('drop', e=> addFiles(e.dataTransfer.files));

  // Thumbnails render + interactions
  let dragIdx = null;
  function renderThumbs(){
    if (!thumbs) return;
    thumbs.innerHTML = '';
    state.slides.forEach((s,i)=>{
      const d = document.createElement('div'); d.className='thumb'; d.draggable = true; d.dataset.idx = String(i);
      d.innerHTML = `<span class="idx">${i+1}</span><img src="${s.url}" alt=""><div class="del" title="Remove">×</div>`;
      thumbs.appendChild(d);
    });
  }

  thumbs?.addEventListener('dragstart', e=>{ const t=e.target.closest('.thumb'); if(!t) return; dragIdx = +t.dataset.idx; e.dataTransfer.effectAllowed='move'; });
  thumbs?.addEventListener('dragover', e=>{ e.preventDefault(); });
  thumbs?.addEventListener('drop', e=>{ e.preventDefault(); const t=e.target.closest('.thumb'); if(!t||dragIdx==null) return; const to=+t.dataset.idx; if (to===dragIdx) return; state.reorderSlides(dragIdx, to); dragIdx=null; });
  thumbs?.addEventListener('click', e=>{ const del=e.target.closest('.del'); const t=e.target.closest('.thumb'); if (del&&t){ state.removeSlide(+t.dataset.idx); }});

  // Re-render thumbs on state changes
  state.on('slides:changed', renderThumbs);
  // Initial render
  renderThumbs();
}

// --------------------------------- Controls ---------------------------------
export function bindControls(state, renderer, exporter, els){
  const ids = {
    resPreset: 'resPreset', layoutMode:'layoutMode', layout:'layout', layoutPick:'layoutPick', playlistWrap:'playlistWrap', playlist:'playlist', addPageBtn:'addPageBtn', clearPlaylistBtn:'clearPlaylistBtn',
    fitMode:'fitMode', padPx:'padPx', radiusPx:'radiusPx', bgStyle:'bgStyle', bgColor:'bgColor',
    motionMode:'motionMode', motionAmt:'motionAmt', motionSpeed:'motionSpeed',
    transitionType:'transitionType', transitionSec:'transitionSec', holdSec:'holdSec', fps:'fps', bitrate:'bitrate', loopPrev:'loopPrev',
    filtersRandom:'filtersRandom', reshuffleFilters:'reshuffleFilters'
  };

  const el = Object.fromEntries(Object.entries(ids).map(([k,id])=>[k, document.getElementById(id)]));

  // Helper to read filter checkboxes
  function readFilters(){
    const picks = Array.from(document.querySelectorAll('.filterPick'));
    return picks.filter(n=> n.checked).map(n=> n.value);
  }

  function applySettingsFromUI(){
    state.updateSettings({
      resKey: el.resPreset?.value || state.settings.resKey,
      layoutMode: el.layoutMode?.value || state.settings.layoutMode,
      layout: el.layout?.value || state.settings.layout,
      layoutPool: Array.from(el.layoutPick?.querySelectorAll('input[type="checkbox"]')||[])
        .filter(n=> n.checked).map(n=> n.value),
      fitMode: el.fitMode?.value || state.settings.fitMode,
      padPx: parseInt(el.padPx?.value || state.settings.padPx),
      radiusPx: parseInt(el.radiusPx?.value || state.settings.radiusPx),
      bgStyle: el.bgStyle?.value || state.settings.bgStyle,
      bgColor: el.bgColor?.value || state.settings.bgColor,

      motionMode: el.motionMode?.value || state.settings.motionMode,
      motionAmt: parseFloat(el.motionAmt?.value || state.settings.motionAmt),
      motionSpeed: parseFloat(el.motionSpeed?.value || state.settings.motionSpeed),

      filtersSelected: readFilters(),
      filtersRandom: !!el.filtersRandom?.checked,

      transitionType: el.transitionType?.value || state.settings.transitionType,
      transitionSec: parseFloat(el.transitionSec?.value || state.settings.transitionSec),
      holdSec: parseFloat(el.holdSec?.value || state.settings.holdSec),

      fps: parseInt(el.fps?.value || state.settings.fps),
      bitrate: parseInt(el.bitrate?.value || state.settings.bitrate),
      loopPreview: (el.loopPrev?.value === '1'),
    });

    // UI mirrors
    const valPad     = document.getElementById('valPad');
    const valRadius  = document.getElementById('valRadius');
    const valTrans   = document.getElementById('valTransition');
    const valHold    = document.getElementById('valHold');
    const valMAmt    = document.getElementById('valMotionAmt');
    const valMSpeed  = document.getElementById('valMotionSpeed');
    const valBitrate = document.getElementById('valBitrate');

    if (valPad)     valPad.textContent     = `${state.settings.padPx} px`;
    if (valRadius)  valRadius.textContent  = `${state.settings.radiusPx} px`;
    if (valTrans)   valTrans.textContent   = `${state.settings.transitionSec.toFixed(1)}s`;
    if (valHold)    valHold.textContent    = `${state.settings.holdSec.toFixed(1)}s`;
    if (valMAmt)    valMAmt.textContent    = `${state.settings.motionAmt.toFixed(2)}×`;
    if (valMSpeed)  valMSpeed.textContent  = `${state.settings.motionSpeed.toFixed(2)}×`;
    if (valBitrate) valBitrate.textContent = `${(state.settings.bitrate/1_000_000).toFixed(1)} Mbps`;

    updateInfoPills(state, els);
    renderer.resizeToPreset(state.settings.resKey);
  }

  // Bind inputs
  const inputs = [el.resPreset, el.layoutMode, el.layout, el.layoutPick, el.fitMode, el.padPx, el.radiusPx, el.bgStyle, el.bgColor,
                  el.motionMode, el.motionAmt, el.motionSpeed, el.filtersRandom, el.transitionType, el.transitionSec, el.holdSec,
                  el.fps, el.bitrate, el.loopPrev];
  inputs.forEach(n=>{
    if (!n) return;
    n.addEventListener('input', applySettingsFromUI);
    n.addEventListener('change', applySettingsFromUI);
  });

  // Filter checkboxes
  document.querySelectorAll('.filterPick').forEach(n=>{
    n.addEventListener('change', applySettingsFromUI);
  });

  // Reshuffle seeds (affects random layout/motion/filters)
  el.reshuffleFilters?.addEventListener('click', ()=>{
    state.reshuffleSeed();
    if (els.status) els.status.textContent = 'Shuffled random choices.';
  });

  // Layout mode toggles playlist UI
  function refreshPlaylistUIVisibility(){
    const wrap = document.getElementById('playlistWrap');
    if (!wrap) return;
    wrap.classList.toggle('active', state.settings.layoutMode === 'playlist');
  }

  // Playlist management UI
  function renderPlaylist(){
    const cont = document.getElementById('playlist'); if (!cont) return;
    cont.innerHTML = '';
    const pages = state.playlist;
    pages.forEach((page, i)=>{
      const firstIdx = page.idxs?.[0] ?? 0;
      const img = state.slides[firstIdx]?.img;
      const card = document.createElement('div'); card.className='playlist-page';
      const thumb = document.createElement('div'); thumb.className='thumb';
      if (img){ const im=document.createElement('img'); im.src = state.slides[firstIdx].url; thumb.appendChild(im); }
      const meta = document.createElement('div'); meta.className='meta';
      meta.innerHTML = `<div class="title">Page ${i+1}</div><div class="sub">Layout & indices</div>`;
      const actions = document.createElement('div'); actions.className='actions';

      // Layout selector
      const sel = document.createElement('select'); sel.innerHTML = `
        <option value="single">Single</option>
        <option value="side">Side</option>
        <option value="triptych">Triptych</option>
        <option value="grid2x2">Grid 2×2</option>`;
      sel.value = page.layout || 'single';
      sel.addEventListener('change', ()=>{ page.layout = sel.value; normalizeIdxs(page); state.playlistSet(pages); renderPlaylist(); });

      // Indices input
      const idxInput = document.createElement('input'); idxInput.type='text'; idxInput.className='input'; idxInput.placeholder='e.g. 0,1,2'; idxInput.value = (page.idxs||[]).join(',');
      idxInput.addEventListener('change', ()=>{
        const arr = idxInput.value.split(',').map(s=> parseInt(s.trim())).filter(n=> !Number.isNaN(n)).map(n=> clamp(n,0,state.slides.length-1));
        page.idxs = arr; normalizeIdxs(page); state.playlistSet(pages); renderPlaylist();
      });

      function normalizeIdxs(p){
        const need = LAYOUTS[p.layout] || 1;
        while(p.idxs.length < need) p.idxs.push(p.idxs[p.idxs.length-1] ?? 0);
        p.idxs = p.idxs.slice(0, need);
      }

      // Move / Delete buttons
      const btnUp = document.createElement('button'); btnUp.className='btn small ghost'; btnUp.textContent='↑'; btnUp.title='Move up';
      btnUp.addEventListener('click', ()=>{ if (i<=0) return; const [it]=pages.splice(i,1); pages.splice(i-1,0,it); state.playlistSet(pages); renderPlaylist(); });
      const btnDown = document.createElement('button'); btnDown.className='btn small ghost'; btnDown.textContent='↓'; btnDown.title='Move down';
      btnDown.addEventListener('click', ()=>{ if (i>=pages.length-1) return; const [it]=pages.splice(i,1); pages.splice(i+1,0,it); state.playlistSet(pages); renderPlaylist(); });
      const btnDel = document.createElement('button'); btnDel.className='btn small'; btnDel.textContent='✕'; btnDel.title='Remove';
      btnDel.addEventListener('click', ()=>{ pages.splice(i,1); state.playlistSet(pages); renderPlaylist(); });

      const left = document.createElement('div'); left.appendChild(thumb);
      const mid  = document.createElement('div'); mid.className='meta'; mid.appendChild(meta); mid.appendChild(sel); mid.appendChild(idxInput);
      const right= document.createElement('div'); right.className='actions'; right.appendChild(btnUp); right.appendChild(btnDown); right.appendChild(btnDel);

      card.appendChild(left); card.appendChild(mid); card.appendChild(right);
      cont.appendChild(card);
    });
  }

  el.addPageBtn?.addEventListener('click', ()=>{
    const defLayout = 'single';
    const nextIdx = state.playlist.at(-1)?.idxs?.at(-1) ?? -1;
    const i0 = clamp(nextIdx+1, 0, Math.max(0, state.slides.length-1));
    state.playlistAddPage(defLayout, [i0]);
    renderPlaylist();
  });
  el.clearPlaylistBtn?.addEventListener('click', ()=>{ state.playlistClear(); renderPlaylist(); });

  state.on('slides:changed', renderPlaylist);
  state.on('pages:recomputed', ()=>{ refreshPlaylistUIVisibility(); updateInfoPills(state, els); });

  // Initial
  refreshPlaylistUIVisibility();
  renderPlaylist();
  applySettingsFromUI();
}

// ------------------------------- Info & Seek --------------------------------
export function updateInfoPills(state, els){
  if (els.infoCount) els.infoCount.textContent = `${state.slides.length} photo${state.slides.length===1?'':'s'}`;
  if (els.infoPages) els.infoPages.textContent = `${state.pageCount()} page${state.pageCount()===1?'':'s'}`;
  if (els.infoDur) els.infoDur.textContent = fmtTime(state.totalDuration(false));
  if (els.infoRes && els.canvas) els.infoRes.textContent = `${els.canvas.width}×${els.canvas.height}`;
  // Update seek total
  if (els.totalTime) els.totalTime.textContent = fmtTime(state.totalDuration(false));
  if (els.seek) els.seek.max = (state.totalDuration(false)||0).toFixed(2);
}

export function updateSeekUI(state, els, t){
  const dur = state.totalDuration(false) || 0;
  if (els.seek) els.seek.value = String(clamp(t, 0, dur));
  if (els.currTime) els.currTime.textContent = fmtTime(clamp(t,0,dur));
  if (els.totalTime) els.totalTime.textContent = fmtTime(dur);
}

// --------------------------------- Theme ------------------------------------
export function setThemeFromToggle(toggle){
  if (!toggle) return;
  const key = 'slideshow.theme';
  const saved = localStorage.getItem(key) || 'dark';
  const body = document.body;
  body.setAttribute('data-theme', saved);
  toggle.checked = (saved === 'light');
  toggle.addEventListener('change', ()=>{
    const theme = toggle.checked ? 'light' : 'dark';
    body.setAttribute('data-theme', theme);
    localStorage.setItem(key, theme);
  });
}
