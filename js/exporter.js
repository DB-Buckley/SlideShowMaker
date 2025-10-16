// exporter.js — Deterministic export. No rAF; we step frames exactly at t=i/fps.
// Path A (preferred MP4): MediaStreamTrackGenerator + MediaRecorder('video/mp4')
// Path B (always reliable): WebCodecs → VP9 + tiny WebM muxer (offline, fast)

import { waitNextFrame } from './utils.js';

function supportsMp4Recorder() {
  return typeof MediaRecorder !== 'undefined' &&
         MediaRecorder.isTypeSupported &&
         MediaRecorder.isTypeSupported('video/mp4;codecs=avc1.42E01E');
}
function supportsTrackGenerator() {
  return 'MediaStreamTrackGenerator' in window && 'VideoFrame' in window;
}
function supportsWebCodecsVP9() {
  return 'VideoEncoder' in window && 'VideoFrame' in window;
}

/*** Minimal WebM muxer for VP9 CFR ***/
class WebMMuxer {
  constructor({width,height,fps,codec='V_VP9'}={}) {
    this.width=width; this.height=height; this.fps=fps; this.codec=codec;
    this.timecodeScale=1_000_000; // 1ms
    this.segment=[]; this.cluster=[]; this.clusterTimecode=0;
    this.frameCount=0;
    this._writeHeader();
  }
  _str(s){ return new TextEncoder().encode(s); }
  _u16(v){ const b=new Uint8Array(2); new DataView(b.buffer).setUint16(0,v); return b; }
  _u32(v){ const b=new Uint8Array(4); new DataView(b.buffer).setUint32(0,v); return b; }
  _vint(n){ const b=new Uint8Array(8); for(let i=7;i>=0;i--){ b[i]=n&0xff; n>>>=8; } b[0]|=0x01; return b; }
  _chunk(id,data){ return new Blob([new Uint8Array(id), this._vint(data.size ?? data.length), data]); }
  _writeHeader(){
    const EBML = this._chunk([0x1A,0x45,0xDF,0xA3], new Uint8Array([
      0x42,0x86,0x81,0x01, 0x42,0xF7,0x81,0x01, 0x42,0xF2,0x81,0x04,
      0x42,0xF3,0x81,0x08, 0x42,0x82,0x84,0x77,0x65,0x62,0x6D
    ]));
    const Video = new Blob([
      new Uint8Array([0xE0]), this._vint(10),
      new Uint8Array([0xB0,0x82]), this._u16(this.width),
      new Uint8Array([0xBA,0x82]), this._u16(this.height)
    ]);
    const CodecID = this._chunk([0x86], this._str(this.codec));
    const TrackEntry = new Blob([
      new Uint8Array([0xAE]), this._vint(35 + CodecID.size + Video.size),
      new Uint8Array([0xD7,0x81,0x01]), // TrackNumber
      new Uint8Array([0x73,0xC5,0x81,0x01]), // TrackUID
      new Uint8Array([0x83,0x81,0x01]), // Type = video
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
      new Uint8Array([0x1F,0x43,0xB6,0x75]), new Uint8Array([0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF]),
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
      new Uint8Array([0x81]), // Track 1
      this._u16(tc),
      new Uint8Array([ key?0x80:0x00 ]),
      new Uint8Array(data)
    ]);
    this.cluster.push(block);
    this.frameCount++;
    if (tc >= 5000){ // new cluster every ~5s
      this._flushCluster();
    }
  }
  _flushCluster(){ if (this.cluster.length){ this.segment.push(...this.cluster); this.cluster=[]; } }
  finalize(){ this._flushCluster(); return new Blob(this.segment, { type:'video/webm' }); }
}

export class Exporter{
  constructor(canvas, renderer, state, els){
    this.canvas = canvas; this.renderer = renderer; this.state = state; this.els = els;
  }

  async export(){
    // Try deterministic MP4 first (only if both MP4 recorder + track generator exist)
    if (supportsMp4Recorder() && supportsTrackGenerator()){
      return await this._exportMp4Deterministic();
    }
    // Otherwise use WebCodecs → WebM (deterministic, reliable everywhere WebCodecs exists)
    if (supportsWebCodecsVP9()){
      return await this._exportWebMDeterministic();
    }
    // Last resort: tell user clearly (should be rare in 2025)
    throw new Error('No deterministic export path available in this browser.');
  }

  /*** Path A: Deterministic MP4 via TrackGenerator + MediaRecorder ***/
  async _exportMp4Deterministic(){
    const fps = +this.state.settings.fps;
    const bitrate = Math.round(+this.state.settings.bitrate);
    const w = this.canvas.width, h = this.canvas.height;

    const gen = new MediaStreamTrackGenerator({ kind: 'video' });
    const writer = gen.writable.getWriter();
    const stream = new MediaStream([gen]);
    const rec = new MediaRecorder(stream, { mimeType:'video/mp4;codecs=avc1.42E01E', videoBitsPerSecond: bitrate });
    const chunks = [];
    rec.ondataavailable = e=> { if (e.data && e.data.size) chunks.push(e.data); };

    const totalSec = this.state.totalDuration(false);
    const totalFrames = Math.ceil(totalSec * fps);
    const prog = this.els?.progBar;
    const updateProg = (i)=> prog && (prog.style.width = ((i/totalFrames)*100).toFixed(1)+'%');

    rec.start(1000); // collect chunks periodically

    for (let i=0;i<totalFrames;i++){
      const t = i / fps;
      this.renderer.drawAt(t, false);
      // IMPORTANT: create VideoFrame with exact timestamp (microseconds)
      const frame = new VideoFrame(this.canvas, { timestamp: Math.round(1e6 * (i / fps)) });
      await writer.write(frame);
      frame.close();
      if ((i & 31) === 0) await waitNextFrame(); // yield to keep UI responsive
      if ((i & 15) === 0) updateProg(i);
    }
    await writer.close();

    await new Promise(res=> { rec.onstop = res; rec.stop(); });
    const blob = new Blob(chunks, { type:'video/mp4' });
    await this._download(blob, this._fileName('mp4'));
    updateProg(totalFrames);
    return blob;
  }

  /*** Path B: Deterministic WebM (VP9) via WebCodecs ***/
  async _exportWebMDeterministic(){
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
      const vf = new VideoFrame(this.canvas, { timestamp: Math.round(1e6 * (i / fps)) });
      encoder.encode(vf, { keyFrame: (i % (fps*2)) === 0 });
      vf.close();
      if ((i & 127) === 0) await waitNextFrame();
      if ((i & 15) === 0) updateProg(i);
    }
    await encoder.flush();

    // Mux to WebM
    const muxer = new WebMMuxer({ width:w, height:h, fps, codec:'V_VP9' });
    for (const c of encoded){
      const data = new Uint8Array(c.byteLength); c.copyTo(data);
      muxer.addFrame(data, c.type === 'key');
    }
    const blob = muxer.finalize();
    await this._download(blob, this._fileName('webm'));
    updateProg(totalFrames);
    return blob;
  }

  _fileName(ext){
    const stamp = new Date().toISOString().slice(0,19).replace(/[:T]/g,'-');
    return `slideshow-${stamp}.${ext}`;
  }

  async _download(blob, name){
    try{
      if ('showSaveFilePicker' in window){
        const handle = await window.showSaveFilePicker({
          suggestedName: name,
          types: [{ description: 'Video', accept: { [blob.type || 'video/mp4']: [`.${name.split('.').pop()}`] } }]
        });
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
        if (this.els?.dlArea) this.els.dlArea.innerHTML = `Saved: <b>${name}</b>`;
        return;
      }
    }catch(e){ console.warn('showSaveFilePicker failed:', e); }

    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
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
