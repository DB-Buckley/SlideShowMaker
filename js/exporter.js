// exporter.js — Deterministic WebM export + optional MP4 conversion (ffmpeg.wasm)
// Robust local-first loader: auto-detects /public/vendor/ffmpeg/ under any base path.
// Uses anchor download (no user-gesture issues).
import { waitNextFrame } from './utils.js';

/*** Minimal WebM muxer for VP9 CFR ***/
class WebMMuxer {
  constructor({width,height,fps,codec='V_VP9'}={}) {
    this.width=width; this.height=height; this.fps=fps; this.codec=codec;
    this.timecodeScale=1_000_000; // 1ms
    this.segment=[]; this.cluster=[]; this.clusterTimecode=0; this.frameCount=0;
    this._writeHeader();
  }
  _str(s){ return new TextEncoder().encode(s); }
  _u16(v){ const b=new Uint8Array(2); new DataView(b.buffer).setUint16(0,v); return b; }
  _u32(v){ const b=new Uint8Array(4); new DataView(b.buffer).setUint32(0,v); return b; }
  _vint(n){ const b=new Uint8Array(8); for(let i=7;i>=0;i--){ b[i]=n&0xff; n>>>=8; } b[0]|=0x01; return b; }
  _chunk(id,data){ const bytes = data instanceof Blob ? data : new Uint8Array(data); return new Blob([new Uint8Array(id), this._vint(bytes.size ?? bytes.length), bytes]); }
  _writeHeader(){
    const EBML = this._chunk([0x1A,0x45,0xDF,0xA3], new Uint8Array([
      0x42,0x86,0x81,0x01, 0x42,0xF7,0x81,0x01, 0x42,0xF2,0x81,0x04,
      0x42,0xF3,0x81,0x08, 0x42,0x82,0x84,0x77,0x65,0x62,0x6D
    ]));
    const Video = new Blob([ new Uint8Array([0xE0]), this._vint(10),
      new Uint8Array([0xB0,0x82]), this._u16(this.width),
      new Uint8Array([0xBA,0x82]), this._u16(this.height) ]);
    const CodecID = this._chunk([0x86], this._str(this.codec));
    const TrackEntry = new Blob([
      new Uint8Array([0xAE]), this._vint(35 + CodecID.size + Video.size),
      new Uint8Array([0xD7,0x81,0x01]),
      new Uint8Array([0x73,0xC5,0x81,0x01]),
      new Uint8Array([0x83,0x81,0x01]),
      new Uint8Array([0xE0]), this._vint(Video.size), Video,
      new Uint8Array([0x86]), this._vint(CodecID.size), CodecID
    ]);
    const Tracks = new Blob([ new Uint8Array([0x16,0x54,0xAE,0x6B]), this._vint(TrackEntry.size), TrackEntry ]);
    const TimecodeScale = new Blob([ new Uint8Array([0x2A,0xD7,0xB1]), this._vint(4), this._u32(this.timecodeScale) ]);
    const MuxingApp = this._chunk([0x4D,0x80], this._str('slideshow-fast'));
    const WritingApp = this._chunk([0x57,0x41], this._str('webcodecs'));
    const Info = new Blob([
      new Uint8Array([0x15,0x49,0xA9,0x66]),
      this._vint(TimecodeScale.size + MuxingApp.size + WritingApp.size),
      TimecodeScale, MuxingApp, WritingApp
    ]);
    this.segment.push(
      EBML,
      new Uint8Array([0x18,0x53,0x80,0x67]), this._vint(Info.size + Tracks.size + 10),
      Info, Tracks
    );
  }
  _startCluster(){
    this.clusterTimecode = Math.round(this.frameCount * (1000/this.fps));
    const header = new Blob([
      new Uint8Array([0x1F,0x43,0xB6,0x75]),
      new Uint8Array([0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF]),
      new Uint8Array([0xE7,0x81]), new Uint8Array([this.clusterTimecode & 0xFF])
    ]);
    this.cluster = [header];
  }
  addFrame(data, key=false){
    if (!this.cluster.length) this._startCluster();
    const tc = Math.round(this.frameCount * (1000/this.fps)) - this.clusterTimecode;
    const block = new Blob([
      new Uint8Array([0xA3]),
      this._vint(1 + 2 + 1 + data.byteLength),
      new Uint8Array([0x81]),
      this._u16(tc),
      new Uint8Array([ key?0x80:0x00 ]),
      new Uint8Array(data)
    ]);
    this.cluster.push(block);
    this.frameCount++;
    if (tc >= 5000){ this._flushCluster(); }
  }
  _flushCluster(){ if (this.cluster.length){ this.segment.push(...this.cluster); this.cluster=[]; } }
  finalize(){ this._flushCluster(); return new Blob(this.segment, { type:'video/webm' }); }
}

function supportsWebCodecs(){ return 'VideoEncoder' in window && 'VideoFrame' in window; }

/* ---------- Local-first FFmpeg loader with smart base detection ---------- */
function guessLocalBases(){
  // 1) Explicit override if you set: <script>window.__FFMPEG_BASE='/myapp/vendor/ffmpeg/'</script>
  const exp = (typeof window !== 'undefined' && window.__FFMPEG_BASE) ? [window.__FFMPEG_BASE] : [];

  // 2) Relative to current page (works under any subpath): ./vendor/ffmpeg/ and vendor/ffmpeg/
  const rel = ['./vendor/ffmpeg/', 'vendor/ffmpeg/'];

  // 3) Absolute from site root (works if app is at '/'): /vendor/ffmpeg/
  const abs = ['/vendor/ffmpeg/'];

  // 4) Relative to the script that imported this module (when available)
  let scriptRel = [];
  try{
    const scripts = Array.from(document.getElementsByTagName('script'));
    const mod = scripts.find(s=> s.type === 'module' && s.src.includes('/js/main.js')) || scripts[scripts.length-1];
    if (mod && mod.src){
      const url = new URL(mod.src, document.baseURI);
      const basePath = url.pathname.replace(/\/js\/[^/]*$/, '/');
      scriptRel = [ basePath + 'vendor/ffmpeg/' ];
    }
  }catch{}

  return [...exp, ...scriptRel, ...rel, ...abs];
}

const FFMPEG_BASES = [
  ...guessLocalBases(),
  'https://unpkg.com/@ffmpeg/ffmpeg@0.12.6/dist/',
  'https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.6/dist/'
];

async function loadFFmpegBundle(updateDlArea){
  if (window.FFmpeg?.createFFmpeg) return { createFFmpeg: window.FFmpeg.createFFmpeg, base: null };
  let lastErr;
  for (const base of FFMPEG_BASES){
    try{
      await new Promise((resolve, reject)=>{
        const s = document.createElement('script');
        s.src = base + 'ffmpeg.min.js';
        s.async = true;
        s.onload = resolve;
        s.onerror = ()=> reject(new Error('Failed to load ' + s.src));
        document.head.appendChild(s);
      });
      if (!window.FFmpeg?.createFFmpeg) throw new Error('ffmpeg.min.js loaded, but API missing.');
      return { createFFmpeg: window.FFmpeg.createFFmpeg, base };
    }catch(e){
      lastErr = e;
      updateDlArea?.(`FFmpeg load failed from ${base} — trying next…`);
    }
  }
  throw lastErr || new Error('Could not load FFmpeg from any source.');
}

/* ---------------- Exporter ---------------- */
export class Exporter{
  constructor(canvas, renderer, state, els){
    this.canvas = canvas; this.renderer = renderer; this.state = state; this.els = els;
    this.lastWebM = null;
  }

  // Deterministic WebM (VP9) export
  async exportWebM(){
    if (!supportsWebCodecs()){
      throw new Error('WebCodecs not supported in this browser.');
    }
    const fps = +this.state.settings.fps;
    const bitrate = Math.round(+this.state.settings.bitrate);
    const w = this.canvas.width, h = this.canvas.height;

    const encoded = [];
    const encoder = new VideoEncoder({
      output: chunk => encoded.push(chunk),
      error: e => console.error(e),
    });
    await encoder.configure({ codec: 'vp09.00.10.08', width: w, height: h, bitrate, framerate: fps });

    const totalSec = this.state.totalDuration(false);
    const totalFrames = Math.ceil(totalSec * fps);
    const prog = this.els?.progBar;
    const updateProg = (i)=> prog && (prog.style.width = ((i/totalFrames)*100).toFixed(1)+'%');

    for (let i=0;i<totalFrames;i++){
      const t = i / fps;
      this.renderer.drawAt(t, false);
      const vf = new VideoFrame(this.canvas, { timestamp: Math.round(1e6 * t) });
      encoder.encode(vf, { keyFrame: (i % (fps*2)) === 0 });
      vf.close();
      if ((i & 127) === 0) await waitNextFrame();
      if ((i & 15) === 0) updateProg(i);
    }
    await encoder.flush();

    const muxer = new WebMMuxer({ width:w, height:h, fps, codec:'V_VP9' });
    for (const c of encoded){
      const data = new Uint8Array(c.byteLength); c.copyTo(data);
      muxer.addFrame(data, c.type === 'key');
    }
    const webm = muxer.finalize();
    this.lastWebM = webm;

    await this._download(webm, this._fileName('webm'));
    updateProg(totalFrames);
    return webm;
  }

  // WebM → MP4 (ffmpeg.wasm) with local-first loader
  async convertWebMtoMP4(webmBlob, onProgress){
    const setStatus = (msg)=>{ this.els?.dlArea && (this.els.dlArea.innerHTML = msg); };

    let loader;
    try{
      loader = await loadFFmpegBundle(setStatus);
    }catch(e){
      throw new Error('Failed to load FFmpeg (local/CDN). Place files in public/vendor/ffmpeg/ OR set window.__FFMPEG_BASE. ' + e.message);
    }

    const { createFFmpeg, base } = loader;
    // Choose corePath based on the same base that loaded ffmpeg.min.js
    const corePath = (base || guessLocalBases()[0]) + 'ffmpeg-core.js';

    const ffmpeg = createFFmpeg({
      log: true,
      corePath,
      progress: p => { if (onProgress && p && typeof p.ratio === 'number') onProgress(p); }
    });

    try{
      await ffmpeg.load();
    }catch(e){
      throw new Error('FFmpeg core failed to load from ' + corePath + '. ' + e.message);
    }

    const data = new Uint8Array(await webmBlob.arrayBuffer());
    ffmpeg.FS('writeFile', 'in.webm', data);

    try{
      await ffmpeg.run(
        '-i','in.webm',
        '-c:v','libx264',
        '-pix_fmt','yuv420p',
        '-crf','18',
        '-preset','veryfast',
        '-movflags','+faststart',
        'out.mp4'
      );
    }catch(e){
      throw new Error('FFmpeg conversion error: ' + (e?.message || e));
    }

    const mp4 = ffmpeg.FS('readFile','out.mp4');
    const mp4Blob = new Blob([mp4.buffer], { type:'video/mp4' });

    try{ ffmpeg.FS('unlink','in.webm'); }catch{}
    try{ ffmpeg.FS('unlink','out.mp4'); }catch{}

    return mp4Blob;
  }

  _fileName(ext){
    const stamp = new Date().toISOString().slice(0,19).replace(/[:T]/g,'-');
    return `slideshow-${stamp}.${ext}`;
  }

  // Anchor-only download
  async _download(blob, name){
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    setTimeout(()=> {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 4000);

    if (this.els?.dlArea){
      const url = URL.createObjectURL(blob);
      this.els.dlArea.innerHTML = `If the download didn’t start, <a href="${url}" download="${name}">click to save ${name}</a>.`;
    }
  }
}
