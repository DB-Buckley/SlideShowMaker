// exporter.js — fast exporter using WebCodecs when available; fallback to MediaRecorder
import { waitNextFrame } from './utils.js';

function supportsWebCodecs(){
  return 'VideoEncoder' in window && 'VideoFrame' in window;
}

class WebMMuxer {
  constructor({width,height,fps,codec='V_VP9'}={}){
    this.width=width; this.height=height; this.fps=fps; this.codec=codec;
    this.clusterTimecode=0; this.trackNum=1; this.timecodeScale=1_000_000;
    this.segment = []; this.cluster = []; this.frameCount = 0; this._writeHeader();
  }
  _u8(arr){ return new Uint8Array(arr); }
  _str(s){ return new TextEncoder().encode(s); }
  _vint(value){ const b = new Uint8Array(8); for (let i=7;i>=0;i--){ b[i]=value&0xFF; value>>>=8; } b[0]|=0x01; return b; }
  _u32(v){ const b=new Uint8Array(4); new DataView(b.buffer).setUint32(0,v); return b; }
  _u16(v){ const b=new Uint8Array(2); new DataView(b.buffer).setUint16(0,v); return b; }
  _chunk(id, bytes){ return new Blob([new Uint8Array(id), this._vint(bytes.length), bytes]); }
  _writeHeader(){
    const EBML = this._chunk([0x1A,0x45,0xDF,0xA3], new Uint8Array([
      0x42,0x86,0x81,0x01,0x42,0xF7,0x81,0x01,0x42,0xF2,0x81,0x04,0x42,0xF3,0x81,0x08,0x42,0x82,0x84,0x77,0x65,0x62,0x6D]));
    const Video = new Blob([ new Uint8Array([0xE0]), this._vint(10),
      new Uint8Array([0xB0,0x82]), this._u16(this.width),
      new Uint8Array([0xBA,0x82]), this._u16(this.height) ]);
    const CodecID = this._chunk([0x86], this._str(this.codec));
    const TrackEntry = new Blob([ new Uint8Array([0xAE]), this._vint(35 + CodecID.size + Video.size),
      new Uint8Array([0xD7,0x81,0x01]), new Uint8Array([0x73,0xC5,0x81,0x01]), new Uint8Array([0x83,0x81,0x01]),
      new Uint8Array([0xE0]), this._vint(Video.size), Video, new Uint8Array([0x86]), this._vint(CodecID.size), CodecID ]);
    const Tracks = new Blob([ new Uint8Array([0x16,0x54,0xAE,0x6B]), this._vint(TrackEntry.size), TrackEntry ]);
    const TimecodeScale = new Blob([new Uint8Array([0x2A,0xD7,0xB1]), this._vint(4), this._u32(this.timecodeScale)]);
    const MuxingApp = this._chunk([0x4D,0x80], this._str('slideshow-fast'));
    const WritingApp = this._chunk([0x57,0x41], this._str('webcodecs'));
    const InfoInner = new Blob([TimecodeScale, MuxingApp, WritingApp]);
    const Info = new Blob([new Uint8Array([0x15,0x49,0xA9,0x66]), this._vint(InfoInner.size), InfoInner]);
    this.segmentHeader = new Blob([EBML, new Uint8Array([0x18,0x53,0x80,0x67]), this._vint(Info.size + Tracks.size + 10)]);
    this.segment.push(this.segmentHeader, Info, Tracks);
  }
  startCluster(){
    this.clusterTimecode = Math.round(this.frameCount * (1000/this.fps));
    const ClusterHeader = new Blob([ new Uint8Array([0x1F,0x43,0xB6,0x75]), new Uint8Array([0xFF]*8),
      new Uint8Array([0xE7,0x81]), new Uint8Array([this.clusterTimecode & 0xFF]) ]);
    this.cluster = [ClusterHeader];
  }
  addFrame(data, key=false){
    if (!this.cluster.length) this.startCluster();
    const timecode = Math.round(this.frameCount * (1000/this.fps)) - this.clusterTimecode;
    const time = this._u16(timecode);
    const flags = new Uint8Array([ key?0x80:0x00 ]);
    const block = new Blob([ new Uint8Array([0xA3]), this._vint(1 + 2 + 1 + data.byteLength),
      new Uint8Array([0x81]), time, flags, new Uint8Array(data) ]);
    this.cluster.push(block);
    this.frameCount++;
    if (timecode >= 5000){ this.flushCluster(); }
  }
  flushCluster(){ if (!this.cluster.length) return; this.segment.push(...this.cluster); this.cluster = []; }
  finalize(){ this.flushCluster(); return new Blob(this.segment, { type:'video/webm' }); }
}

export class Exporter{
  constructor(canvas, renderer, state, els){
    this.canvas = canvas; this.renderer = renderer; this.state = state; this.els = els;
  }

  async export(){
    if (supportsWebCodecs()){
      return await this._exportWebCodecs();
    }else{
      return await this._exportMediaRecorder();
    }
  }

  async _exportWebCodecs(){
    const { settings } = this.state;
    const fps = +settings.fps;
    const bitrate = Math.round(+settings.bitrate);
    const width = this.canvas.width, height = this.canvas.height;

    const codec = 'vp09.00.10.08';
    const encoded = [];
    const encoder = new VideoEncoder({
      output: c=> encoded.push(c),
      error: e=> console.error(e),
    });
    await encoder.configure({ codec, width, height, bitrate, framerate: fps });

    const totalSec = this.state.totalDuration(false);
    const totalFrames = Math.ceil(totalSec * fps);
    const prog = this.els.progBar;
    const updateProg = (i)=> prog && (prog.style.width = ((i/totalFrames)*100).toFixed(1)+'%');

    for (let i=0;i<totalFrames;i++){
      const t = i / fps;
      this.renderer.drawAt(t, false);
      const frame = new VideoFrame(this.canvas, { timestamp: Math.round(1e6 * (i / fps)) });
      encoder.encode(frame, { keyFrame: i%(fps*2)===0 });
      frame.close();
      if (i%10===0) updateProg(i);
      if (i%120===0) await waitNextFrame();
    }
    await encoder.flush();

    const muxer = new WebMMuxer({ width, height, fps, codec:'V_VP9' });
    for (const c of encoded){
      const data = new Uint8Array(c.byteLength); c.copyTo(data);
      muxer.addFrame(data, c.type === 'key');
    }
    const blob = muxer.finalize();
    updateProg(totalFrames);
    this._download(blob, this._fileName('webm'));
    return blob;
  }

  async _exportMediaRecorder(){
    const stream = this.canvas.captureStream(this.state.settings.fps);
    const rec = new MediaRecorder(stream, { mimeType:'video/webm;codecs=vp9', videoBitsPerSecond: this.state.settings.bitrate });
    const chunks = [];
    rec.ondataavailable = e=> { if (e.data && e.data.size) chunks.push(e.data); };
    const total = this.state.totalDuration(false);
    rec.start();

    const started = performance.now();
    const loop = ()=>{
      const t = (performance.now()-started)/1000;
      if (t >= total){ rec.stop(); return; }
      this.renderer.drawAt(t, false);
      requestAnimationFrame(loop);
    };
    loop();

    await new Promise(res=> rec.onstop = res);
    const blob = new Blob(chunks, { type:'video/webm' });
    this._download(blob, this._fileName('webm'));
    return blob;
  }

  _fileName(ext){
    const now = new Date();
    const stamp = now.toISOString().slice(0,19).replace(/[:T]/g,'-');
    return `slideshow-${stamp}.${ext}`;
  }
  _download(blob, name){
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(()=> URL.revokeObjectURL(a.href), 5000);
  }
}
