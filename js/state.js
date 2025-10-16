// state.js — minimal state for fast slideshow
// ------------------------------------------------------------
export function createState(){
  const bus = new EventTarget();
  const state = {
    slides: [], // {file, url, img}
    settings: {
      resPreset: 'sq',
      fps: 30,
      holdSec: 2.5,
      transitionSec: 0.6,
      motionAmt: 0.12,
      loopPrev: 1,
      bitrate: 8_000_000,
    },
    on(type, fn){ bus.addEventListener(type, fn); },
    emit(type, detail){ bus.dispatchEvent(new CustomEvent(type,{detail})); },
  };
  state.pageCount = ()=> state.slides.length;
  state.totalDuration = (loop=false)=>{
    const n = state.pageCount(); if (!n) return 0;
    const { holdSec, transitionSec } = state.settings;
    return loop? n*(holdSec+transitionSec) : n*holdSec + Math.max(0,n-1)*transitionSec;
  };
  return state;
}
