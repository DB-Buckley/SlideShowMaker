// renderer.js — drawing pages, transitions, layouts, motion & filters
// ---------------------------------------------------------------------------------
// Renders the slideshow on a <canvas> using:
//  • Multiple aspect ratios (via resizeToPreset)
//  • Layouts: single, side, triptych, grid2x2
//  • Background styles: solid or blurred-from-image
//  • Filters: grayscale, sepia, warm, cool, contrast, saturate, blur, vignette
//  • Continuous motion per page (zoom/pan) that *does not reset* at transitions
//  • Transitions: crossfade, slide-* directions, or none

import { STATE_CONST } from './state.js';
const { LAYOUTS } = STATE_CONST;

const RES = {
  sq:   { w:1080, h:1080 },
  '169':{ w:1920, h:1080 },
  '916':{ w:1080, h:1920 },
  '54L':{ w:1350, h:1080 },
  '45P':{ w:1080, h:1350 },
  '32L':{ w:1620, h:1080 },
  '23P':{ w:1080, h:1620 },
};

function clamp(v,min,max){ return Math.max(min, Math.min(max, v)); }
function easePow(p, k){ return Math.pow(clamp(p,0,1), k); }

export class Renderer{
  /** @param {HTMLCanvasElement} canvas @param {ReturnType<import('./state.js').createState>} state */
  constructor(canvas, state){ this.canvas = canvas; this.ctx = canvas.getContext('2d'); this.state = state; }

  resizeToPreset(key){ const r = RES[key] || RES.sq; this.canvas.width = r.w; this.canvas.height = r.h; this.canvas.style.aspectRatio = `${r.w} / ${r.h}`; }

  // ---- Public draw entry ----------------------------------------------------
  drawAt(t, loopFlag){
    const ctx = this.ctx, S = this.state.settings; const pages = this.state.pages();
    if (!pages.length){ this.clear('#000'); return; }

    const seg = this.state.segmentAt(t, loopFlag);
    if (!seg){ this.clear('#000'); return; }

    const trType = S.transitionType; const trDur = trType==='none'?0:+S.transitionSec;

    if (seg.type === 'hold'){
      this.drawPage(seg.i, t, loopFlag);
      return;
    }

    // Transition
    const W = this.canvas.width, H = this.canvas.height;
    const p = clamp(seg.p, 0, 1);

    if (trType === 'crossfade' || trDur === 0){
      this.drawPage(seg.from, t, loopFlag);
      this.ctx.save(); this.ctx.globalAlpha = p; this.drawPage(seg.to, t, loopFlag); this.ctx.restore();
      return;
    }

    // Slide transitions: translate whole page surfaces
    let dxA=0, dyA=0, dxB=0, dyB=0;
    switch(trType){
      case 'slide-left':  dxA = -p*W; dyA = 0;     dxB = (1-p)*W; dyB = 0;     break;
      case 'slide-right': dxA =  p*W; dyA = 0;     dxB = -(1-p)*W; dyB = 0;    break;
      case 'slide-up':    dxA = 0;    dyA = -p*H;  dxB = 0;       dyB = (1-p)*H; break;
      case 'slide-down':  dxA = 0;    dyA =  p*H;  dxB = 0;       dyB = -(1-p)*H; break;
      default: break;
    }

    this.ctx.save(); this.ctx.translate(dxA, dyA); this.drawPage(seg.from, t, loopFlag); this.ctx.restore();
    this.ctx.save(); this.ctx.translate(dxB, dyB); this.drawPage(seg.to, t, loopFlag); this.ctx.restore();
  }

  clear(fill){ const ctx=this.ctx; ctx.save(); ctx.setTransform(1,0,0,1,0,0); ctx.fillStyle=fill||'#000'; ctx.fillRect(0,0,this.canvas.width,this.canvas.height); ctx.restore(); }

  // ---- Page drawing ---------------------------------------------------------
  drawPage(pageIndex, t, loopFlag){
    const pages = this.state.pages(); const page = pages[pageIndex]; if (!page) return;
    const S = this.state.settings; const W = this.canvas.width, H = this.canvas.height;
    const ctx = this.ctx;

    // Background
    this.drawBackground(pageIndex);

    // Layout rects
    const rects = this.layoutRects(page.layout, W, H, S.padPx);

    // Compute motion based on *absolute* time since page start (including transition)
    const t0 = this.pageStartTime(pageIndex, loopFlag);
    const dur = this.pageDuration(pageIndex, loopFlag);
    const u = dur > 0 ? easePow((t - t0) / dur, S.motionSpeed) : 1; // 0→1 across page + transition

    // Render each slot
    for (let i=0; i<rects.length; i++){
      const rect = rects[i];
      const slideIdx = page.idxs[i];
      const slide = this.state.slides[slideIdx];
      if (!slide || !slide.img) continue;

      // Compute per-page motion (same motion for all tiles of the page)
      const motion = this.computeMotion(page.motion, rect, u, S.motionAmt);

      // Filters
      const filterStr = this.composeFilterString(page.filters);

      // Clip to rounded rect and draw
      ctx.save();
      this.roundedRectPath(rect.x, rect.y, rect.w, rect.h, S.radiusPx);
      ctx.clip();

      ctx.filter = filterStr; // canvas filter pipeline
      this.drawImageIntoRect(slide.img, rect, S.fitMode, motion.scale, motion.dx, motion.dy);
      ctx.filter = 'none';

      if (page.filters?.includes('vignette')) this.paintVignette(rect, 0.6);

      ctx.restore();
    }
  }

  // ---- Motion ---------------------------------------------------------------
  /** @returns {{scale:number, dx:number, dy:number}} */
  computeMotion(mode, rect, u, amt){
    const c = clamp(u, 0, 1);
    const A = (amt||0) * 0.5; // translate fraction of rect size
    let scale = 1, dx = 0, dy = 0;
    switch(mode){
      case 'zoom-in':  scale = 1 + (amt||0)*c; break;
      case 'zoom-out': scale = 1 + (amt||0)*(1-c); break;
      case 'pan-left': dx = -A * rect.w * c; break;
      case 'pan-right':dx =  A * rect.w * c; break;
      case 'pan-up':   dy = -A * rect.h * c; break;
      case 'pan-down': dy =  A * rect.h * c; break;
      case 'off':
      default: break;
    }
    return { scale, dx, dy };
  }

  // ---- Filters --------------------------------------------------------------
  composeFilterString(filters){
    if (!filters || !filters.length) return 'none';
    const set = new Set(filters);
    const parts = [];
    if (set.has('grayscale')) parts.push('grayscale(1)');
    if (set.has('sepia'))     parts.push('sepia(0.5)');
    if (set.has('contrast'))  parts.push('contrast(1.15)');
    if (set.has('saturate'))  parts.push('saturate(1.12)');
    if (set.has('blur'))      parts.push('blur(1px)');
    if (set.has('warm'))      parts.push('sepia(0.15) saturate(1.06) hue-rotate(5deg)');
    if (set.has('cool'))      parts.push('saturate(1.04) hue-rotate(-10deg)');
    // vignette is drawn as overlay, not via filter
    return parts.join(' ')
      || 'none';
  }

  paintVignette(rect, strength=0.6){
    const ctx = this.ctx; const {x,y,w,h} = rect;
    const cx = x + w/2, cy = y + h/2; const r = Math.max(w,h)*0.75;
    const g = ctx.createRadialGradient(cx, cy, r*0.25, cx, cy, r);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, `rgba(0,0,0,${clamp(strength,0,1)})`);
    ctx.save();
    this.roundedRectPath(x,y,w,h,0); ctx.clip();
    ctx.fillStyle = g; ctx.fillRect(x,y,w,h);
    ctx.restore();
  }

  // ---- Backgrounds ----------------------------------------------------------
  drawBackground(pageIndex){
    const S = this.state.settings; const W=this.canvas.width, H=this.canvas.height; const ctx=this.ctx;
    if (S.bgStyle === 'blur' && this.state.slides.length){
      const firstIdx = this.state.pages()[pageIndex]?.idxs?.[0] ?? 0;
      const img = this.state.slides[firstIdx]?.img;
      if (img){ ctx.save(); ctx.filter = 'blur(24px) brightness(0.9)'; this.drawImageIntoRect(img, {x:0,y:0,w:W,h:H}, 'cover', 1, 0, 0); ctx.filter='none'; ctx.restore(); return; }
    }
    // Solid color
    ctx.save(); ctx.fillStyle = S.bgColor || '#000'; ctx.fillRect(0,0,W,H); ctx.restore();
  }

  // ---- Layouts --------------------------------------------------------------
  layoutRects(layout, W, H, pad){
    const outer = pad|0, gutter = pad|0;
    if (layout==='single') return [{x:outer, y:outer, w:W-2*outer, h:H-2*outer}];
    if (layout==='side'){
      const cw = (W - 2*outer - gutter)/2, ch = H - 2*outer;
      return [ {x:outer, y:outer, w:cw, h:ch}, {x:outer+cw+gutter, y:outer, w:cw, h:ch} ];
    }
    if (layout==='triptych'){
      const cw = (W - 2*outer - 2*gutter)/3, ch = H - 2*outer;
      return [
        {x:outer, y:outer, w:cw, h:ch},
        {x:outer+cw+gutter, y:outer, w:cw, h:ch},
        {x:outer+2*(cw+gutter), y:outer, w:cw, h:ch},
      ];
    }
    if (layout==='grid2x2'){
      const cw = (W - 2*outer - gutter)/2, ch = (H - 2*outer - gutter)/2;
      return [
        {x:outer, y:outer, w:cw, h:ch},
        {x:outer+cw+gutter, y:outer, w:cw, h:ch},
        {x:outer, y:outer+ch+gutter, w:cw, h:ch},
        {x:outer+cw+gutter, y:outer+ch+gutter, w:cw, h:ch},
      ];
    }
    // fallback
    return [{x:outer, y:outer, w:W-2*outer, h:H-2*outer}];
  }

  // ---- Geometry helpers -----------------------------------------------------
  roundedRectPath(x,y,w,h,r){
    const ctx=this.ctx; const rr=Math.min(r, w/2, h/2)||0;
    ctx.beginPath();
    ctx.moveTo(x+rr, y);
    ctx.arcTo(x+w, y,   x+w, y+h, rr);
    ctx.arcTo(x+w, y+h, x,   y+h, rr);
    ctx.arcTo(x,   y+h, x,   y,   rr);
    ctx.arcTo(x,   y,   x+w, y,   rr);
    ctx.closePath();
  }

  drawImageIntoRect(img, rect, fitMode='cover', scale=1, offx=0, offy=0){
    const ctx=this.ctx; const {x,y,w,h} = rect;
    const iw=img.naturalWidth, ih=img.naturalHeight;
    const base = fitMode==='cover' ? Math.max(w/iw, h/ih) : Math.min(w/iw, h/ih);
    const s = base * (scale||1);
    const dw = iw * s, dh = ih * s;
    const dx = x + (w - dw)/2 + (offx||0);
    const dy = y + (h - dh)/2 + (offy||0);
    ctx.drawImage(img, dx, dy, dw, dh);
  }

  // ---- Timing helpers for continuous motion --------------------------------
  pageStartTime(i, loopFlag){
    const S = this.state.settings; const tr = (S.transitionType==='none'?0:+S.transitionSec); const hold = +S.holdSec;
    if (loopFlag) return i * (hold + tr);
    // non-loop: same start positions (transitions counted before each page)
    return i * (hold + tr);
  }
  pageDuration(i, loopFlag){
    const S = this.state.settings; const tr = (S.transitionType==='none'?0:+S.transitionSec); const hold = +S.holdSec; const n=this.state.pageCount();
    const hasTrans = (loopFlag || i < n-1);
    return hold + (hasTrans ? tr : 0);
  }
}
