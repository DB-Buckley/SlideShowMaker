// state.js — central app state, pages builder, seeded randomness
// ----------------------------------------------------------------------------
// Responsibilities
//  • Hold user settings and slides
//  • Build logical "pages" from slides based on layout mode (fixed/random/playlist)
//  • Provide a deterministic randomiser with seed + reshuffle
//  • Emit events when things change so UI/renderer can react
//  • Duration math + timeline segmentation helpers

// ----- Small event emitter ---------------------------------------------------
class Emitter {
  constructor(){ this.map = new Map(); }
  on(type, fn){ if(!this.map.has(type)) this.map.set(type, new Set()); this.map.get(type).add(fn); return ()=>this.off(type, fn); }
  off(type, fn){ const s=this.map.get(type); if (s) s.delete(fn); }
  emit(type, payload){ const s=this.map.get(type); if(!s) return; for (const fn of Array.from(s)) try{ fn(payload); }catch(e){ console.error(e); } }
}

// ----- Seeded RNG (deterministic) -------------------------------------------
// cyrb128 → sfc32 combo; stable across sessions for same seed string/number
function cyrb128(str){
  let h1 = 1779033703, h2 = 3144134277, h3 = 1013904242, h4 = 2773480762;
  for (let i = 0, k; i < str.length; i++) {
    k = str.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  return [(h1^h2)>>>0, (h3^h4)>>>0, (h1^h3)>>>0, (h2^h4)>>>0];
}
function sfc32(a,b,c,d){
  return function(){ a>>>0; b>>>0; c>>>0; d>>>0; var t=(a+b)|0; a=b^(b>>>9); b=(c+(c<<3))|0; c=(c<<21)|(c>>>11); d=(d+1)|0; t=(t+d)|0; c=(c+t)|0; return (t>>>0)/4294967296; }
}
function makeRNG(seed){
  const s = typeof seed === 'string' ? cyrb128(seed) : cyrb128(String(seed>>>0));
  const r = sfc32(s[0], s[1], s[2], s[3]);
  // discard 256 initial values
  for(let i=0;i<256;i++) r();
  return r;
}

// ----- Helpers ---------------------------------------------------------------
const LAYOUTS = /** @type {const} */({ single:1, side:2, triptych:3, grid2x2:4 });
const LAYOUT_KEYS = Object.keys(LAYOUTS);

const MOTIONS = /** @type {const} */([
  'zoom-in','zoom-out','pan-left','pan-right','pan-up','pan-down'
]);

const FILTERS = /** @type {const} */([
  'grayscale','sepia','warm','cool','contrast','saturate','blur','vignette'
]);

function clamp(v,min,max){ return Math.max(min, Math.min(max, v)); }

// Build pages according to settings.layoutMode
function buildPages(slides, settings, rng, playlist){
  const pages = [];
  const n = slides.length;
  if (!n) return pages;

  const pickMotion = (pageIndex)=>{
    if (settings.motionMode === 'off') return 'off';
    if (settings.motionMode === 'random'){
      // deterministic per-page choice using rng advanced by page index
      const idx = Math.floor(rng() * MOTIONS.length);
      return MOTIONS[idx];
    }
    return settings.motionMode;
  };

  const pickFilters = ()=>{
    const chosen = [];
    if (!settings.filtersRandom){
      for (const f of settings.filtersSelected){ if (FILTERS.includes(f)) chosen.push(f); }
      return chosen;
    }
    // random subset from selected list (if none selected, random from all)
    const pool = settings.filtersSelected.length ? settings.filtersSelected : FILTERS;
    for (const f of pool){ if (rng() < 0.45) chosen.push(f); }
    return chosen;
  };

  if (settings.layoutMode === 'playlist' && Array.isArray(playlist) && playlist.length){
    // Use playlist as-is, but clamp/duplicate indices as needed
    for (let p=0;p<playlist.length;p++){
      const page = playlist[p];
      const idxs = (page.idxs || []).map(i=> clamp(i,0,n-1));
      // Fill to required count for its layout
      const need = LAYOUTS[page.layout] ?? 1;
      while (idxs.length < need) idxs.push(idxs[idxs.length-1] ?? 0);
      pages.push({ layout: page.layout, idxs, motion: page.motion || pickMotion(p), filters: page.filters || pickFilters() });
    }
    return pages;
  }

  if (settings.layoutMode === 'random'){
    const pool = (settings.layoutPool && settings.layoutPool.length) ? settings.layoutPool.filter(k=>LAYOUT_KEYS.includes(k)) : LAYOUT_KEYS;
    let i = 0; // next slide index to consume
    let p = 0;
    while (i < n){
      const layout = pool[Math.floor(rng() * pool.length)] || 'single';
      const g = LAYOUTS[layout] || 1;
      const idxs = [];
      for (let k=0;k<g;k++) idxs.push( i+k < n ? i+k : (n-1));
      i += g;
      pages.push({ layout, idxs, motion: pickMotion(p++), filters: pickFilters() });
    }
    return pages;
  }

  // default: fixed layout
  const g = LAYOUTS[settings.layout] || 1;
  for (let i=0, p=0; i<n; i+=g, p++){
    const idxs = []; for (let k=0;k<g;k++) idxs.push( i+k < n ? i+k : (n-1));
    pages.push({ layout: settings.layout, idxs, motion: pickMotion(p), filters: pickFilters() });
  }
  return pages;
}

// Compute timeline segmentation over pages
function getTimelineSegment(pages, t, holdSec, transSec, loop){
  const n = pages.length; if (!n) return null;
  const tr = (transSec>0) ? transSec : 0;
  const total = loop ? n*(holdSec+tr) : (n*holdSec + Math.max(0, (n-1))*tr);
  if (total <= 0) return { type:'hold', i:0, p:1 };
  let tt = t;
  if (loop){ tt = ((t % total)+total)%total; } else { tt = clamp(t, 0, Math.max(0,total-1e-6)); }
  let time = 0;
  for (let i=0;i<n;i++){
    if (tt < time + holdSec) return { type:'hold', i, p:(tt-time)/holdSec };
    time += holdSec;
    const hasTrans = (i < n-1) || loop;
    if (hasTrans && tr>0){
      if (tt < time + tr) return { type:'trans', from:i, to:(i+1)%n, p:(tt-time)/tr };
      time += tr;
    }
  }
  return { type:'hold', i:n-1, p:1 };
}

// ----- State factory ---------------------------------------------------------
export function createState(){
  const bus = new Emitter();

  const state = {
    slides: /** @type {{img:HTMLImageElement,url:string,name:string,w:number,h:number}[]} */([]),
    playlist: /** @type {{layout: keyof typeof LAYOUTS, idxs:number[], motion?:string, filters?:string[]}[]} */([]),

    settings: {
      // Output & layout
      resKey: 'sq',                    // see renderer for presets
      layoutMode: 'fixed',             // 'fixed' | 'random' | 'playlist'
      layout: 'single',                // when fixed
      layoutPool: ['single','side','triptych','grid2x2'], // when random
      fitMode: 'cover',
      padPx: 16,
      radiusPx: 10,
      bgStyle: 'solid',                // 'solid' | 'blur'
      bgColor: '#000000',

      // Motion (continuous)
      motionMode: 'off',               // 'off' | 'zoom-in' | 'zoom-out' | pans | 'random'
      motionAmt: 0.12,
      motionSpeed: 1.0,

      // Filters
      filtersSelected: /** @type {string[]} */([]),
      filtersRandom: false,

      // Timing
      transitionType: 'crossfade',
      transitionSec: 1.0,
      holdSec: 2.5,

      // Export preview
      fps: 30,
      bitrate: 8_000_000,
      loopPreview: true,

      // Random seed
      seed: (Math.random()*4294967295)>>>0,
    },

    // runtime cache
    _pagesCache: /** @type {ReturnType<typeof buildPages>} */([]),
    _rng: null,

    // --- events ---
    on: (...a)=>bus.on(...a),
    off: (...a)=>bus.off(...a),

    // --- mutations ---
    updateSettings(partial){ Object.assign(state.settings, partial); state._rng = makeRNG(state.settings.seed); recomputePages(); bus.emit('settings:changed'); },
    setSeed(seed){ state.settings.seed = seed; state._rng = makeRNG(seed); recomputePages(); bus.emit('settings:changed'); },
    reshuffleSeed(){ state.setSeed( (Math.random()*4294967295)>>>0 ); },

    addSlide(obj){ state.slides.push(obj); recomputePages(); bus.emit('slides:changed'); },
    addSlides(arr){ for (const o of arr) state.slides.push(o); recomputePages(); bus.emit('slides:changed'); },
    removeSlide(index){ if (index>=0 && index<state.slides.length){ const [s]=state.slides.splice(index,1); try{ URL.revokeObjectURL(s.url); }catch{} recomputePages(); bus.emit('slides:changed'); } },
    reorderSlides(from, to){ if (from===to) return; const [item] = state.slides.splice(from,1); state.slides.splice(to,0,item); recomputePages(); bus.emit('slides:changed'); },
    clearSlides(){ for(const s of state.slides){ try{ URL.revokeObjectURL(s.url);}catch{} } state.slides.length=0; recomputePages(); bus.emit('slides:changed'); },

    // Playlist management (for layoutMode='playlist')
    playlistClear(){ state.playlist.length = 0; recomputePages(); bus.emit('pages:recomputed'); },
    playlistAddPage(layout='single', idxs=[]){ state.playlist.push({ layout, idxs:[...idxs] }); recomputePages(); bus.emit('pages:recomputed'); },
    playlistSet(pages){ state.playlist.length=0; for(const p of pages) state.playlist.push({ layout:p.layout, idxs:[...(p.idxs||[])], motion:p.motion, filters:p.filters }); recomputePages(); bus.emit('pages:recomputed'); },

    // --- queries ---
    pages(){ return state._pagesCache; },
    pageCount(){ return state._pagesCache.length; },
    totalDuration(loop=false){ const n=state.pageCount(); const hold=+state.settings.holdSec; const tr=(state.settings.transitionType==='none'?0:+state.settings.transitionSec); return n? (loop? n*(hold+tr) : n*hold + Math.max(0,(n-1))*tr) : 0; },
    segmentAt(t, loop=false){ return getTimelineSegment(state._pagesCache, t, +state.settings.holdSec, (state.settings.transitionType==='none'?0:+state.settings.transitionSec), loop); },
  };

  function recomputePages(){
    if (!state._rng) state._rng = makeRNG(state.settings.seed);
    // make a fresh RNG snapshot so page choices are stable for this recompute
    const rng = makeRNG(state.settings.seed);
    state._pagesCache = buildPages(state.slides, state.settings, rng, state.playlist);
    bus.emit('pages:recomputed');
  }

  // initialise
  state._rng = makeRNG(state.settings.seed);
  recomputePages();

  return state;
}

// Also export constants for other modules if needed
export const STATE_CONST = { LAYOUTS, MOTIONS, FILTERS };
