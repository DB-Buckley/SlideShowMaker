// renderer.js — lean drawing: single image per page, Ken Burns, crossfade only
// ---------------------------------------------------------------------------------
const RES = {
  sq:   { w:1080, h:1080 },
  '169':{ w:1920, h:1080 },
  '916':{ w:1080, h:1920 },
  '54L':{ w:1350, h:1080 },
  '45P':{ w:1080, h:1350 },
};

function clamp(v,min,max){ return Math.max(min, Math.min(max, v)); }
function easeInOutQuad(t){ t=clamp(t,0,1); return t<0.5? 2*t*t : 1 - Math.pow(-2*t+2,2)/2; }

export class Renderer{
  constructor(canvas, state){
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { desynchronized:true });
    this.state = state;
    this.setRes(state.settings.resPreset);
  }

  setRes(key){
    const r = RES[key] || RES.sq;
    this.canvas.width = r.w; this.canvas.height = r.h;
  }

  drawAt(t, loopFlag){
    const { slides, settings } = this.state;
    const n = slides.length;
    const ctx = this.ctx;
    const W = this.canvas.width, H=this.canvas.height;

    ctx.save();
    ctx.fillStyle = '#000'; ctx.fillRect(0,0,W,H);

    if (!n){ ctx.restore(); return; }

    const hold = +settings.holdSec;
    const tr   = +settings.transitionSec;
    const segDur = hold + tr;
    const total = loopFlag ? n*segDur : n*hold + Math.max(0,(n-1))*tr;
    const tt = loopFlag ? (t % total) : clamp(t,0,total-1e-6);

    // Figure out current slide and next slide + local times
    let idx = 0, accum=0;
    while (true){
      const dur = (idx < n-1 || loopFlag) ? (hold + tr) : hold;
      if (tt < accum + dur) break;
      accum += dur; idx++;
      if (idx >= n){ idx = n-1; break; }
    }
    const local = tt - accum;
    const hasNext = (idx < n-1) || loopFlag;
    const isXfade = hasNext && local > hold - 1e-6;

    const curr = slides[idx];
    const next = hasNext ? slides[(idx+1)%n] : null;

    const motionAmt = +settings.motionAmt;

    // draw current
    if (curr && curr.img.complete){
      const p = clamp(local/hold, 0, 1); // 0..1 across hold
      this.drawKenBurns(curr.img, {x:0,y:0,w:W,h:H}, p, motionAmt, 'inout');
    }

    // crossfade
    if (isXfade && next && next.img.complete){
      const txf = clamp((local - hold)/tr, 0, 1);
      ctx.globalAlpha = easeInOutQuad(txf);
      this.drawKenBurns(next.img, {x:0,y:0,w:W,h:H}, 0, motionAmt, 'inout');
      ctx.globalAlpha = 1;
    }

    ctx.restore();
  }

  drawKenBurns(img, rect, p, amt, mode){
    const {x,y,w,h} = rect;
    const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
    const cover = Math.max(w/iw, h/ih);
    const startScale = cover * (1 + amt);
    const endScale   = cover * (1 - amt*0.5);
    const s = startScale + (endScale - startScale) * easeInOutQuad(p);

    const dw = iw * s, dh = ih * s;
    // subtle pan along diagonal
    const offx = (w - dw)/2 + (w - dw) * (p - 0.5) * 0.2;
    const offy = (h - dh)/2 + (h - dh) * (p - 0.5) * -0.2;

    this.ctx.drawImage(img, x+offx, y+offy, dw, dh);
  }
}
