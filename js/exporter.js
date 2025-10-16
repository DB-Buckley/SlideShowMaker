// exporter.js — Deterministic WebM export (WebCodecs VP9) with a correct minimal WebM muxer.
// - Frame-stepped render (no MediaRecorder). Fast and stable.
// - Clean container: proper Cluster timecodes (32-bit), keyframes every ~2s.
// - Anchor-only download (no user-gesture issues).

import { waitNextFrame } from './utils.js';

/*** Minimal-but-correct WebM muxer for constant-frame-rate VP9 ***/
class WebMMuxer {
  // timecodeScale: 1 ms (1_000_000 ns) so we can reason in whole milliseconds.
  constructor({ width, height, fps, codec = 'V_VP9', timecodeScale = 1_000_000 }) {
    this.width = width;
    this.height = height;
    this.fps = fps;
    this.codec = codec;
    this.timecodeScale = timecodeScale; // ns per tick
    this.segment = [];
    this.cluster = [];
    this.clusterTimecode = 0;      // absolute cluster timecode in ms
    this.frameCount = 0;
    this._writeHeader();
  }

  _te(s) { return new TextEncoder().encode(s); }
  _u16(v) { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, v); return b; }
  _u32(v) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v); return b; }
  _f64(d) { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, d, false); return b; }

  // EBML "variable length integer" for sizes (we'll just use 8-bytes w/ leading 1 bit)
  _vintSize(n) {
    // Encode n length as a vint. For simplicity and robustness, always emit 8-byte vint.
    // First bit 1, remaining 7 bytes carry the length.
    const b = new Uint8Array(8);
    let x = n >>> 0;
    // write as 8-byte big-endian; we only use low 4 bytes for our sizes here.
    for (let i = 7; i >= 0; i--) { b[i] = x & 0xFF; x >>>= 8; }
    b[0] |= 0x01; // set the top marker bit
    return b;
  }

  _chunk(idBytes, payload) {
    const bytes = payload instanceof Blob ? payload : new Uint8Array(payload);
    const size = bytes.size ?? bytes.length;
    return new Blob([new Uint8Array(idBytes), this._vintSize(size), bytes]);
  }

  _writeHeader() {
    // EBML header
    const EBML = this._chunk([0x1A, 0x45, 0xDF, 0xA3], new Uint8Array([
      0x42,0x86,0x81,0x01, // EBMLVersion
      0x42,0xF7,0x81,0x01, // EBMLReadVersion
      0x42,0xF2,0x81,0x04, // EBMLMaxIDLength
      0x42,0xF3,0x81,0x08, // EBMLMaxSizeLength
      0x42,0x82,0x84,0x77,0x65,0x62,0x6D // DocType "webm"
    ]));

    // Video track (no CodecPrivate for VP9)
    const Video = new Blob([
      new Uint8Array([0xE0]), this._vintSize(10),
      new Uint8Array([0xB0,0x82]), this._u16(this.width),  // PixelWidth
      new Uint8Array([0xBA,0x82]), this._u16(this.height)  // PixelHeight
    ]);
    const CodecID = this._chunk([0x86], this._te(this.codec)); // "V_VP9"
    const TrackEntry = new Blob([
      new Uint8Array([0xAE]), this._vintSize(35 + CodecID.size + Video.size),
      new Uint8Array([0xD7,0x81,0x01]), // TrackNumber = 1
      new Uint8Array([0x73,0xC5,0x81,0x01]), // TrackUID = 1
      new Uint8Array([0x83,0x81,0x01]), // TrackType = 1 (video)
      new Uint8Array([0xE0]), this._vintSize(Video.size), Video,
      new Uint8Array([0x86]), this._vintSize(CodecID.size), CodecID
    ]);
    const Tracks = new Blob([ new Uint8Array([0x16,0x54,0xAE,0x6B]), this._vintSize(TrackEntry.size), TrackEntry ]);

    // Segment Info with TimecodeScale and Writing/Muxing app (Duration optional)
    const TimecodeScale = new Blob([
      new Uint8Array([0x2A,0xD7,0xB1]), this._vintSize(4), this._u32(this.timecodeScale)
    ]);
    const MuxingApp = this._chunk([0x4D,0x80], this._te('slideshow-fast'));
    const WritingApp = this._chunk([0x57,0x41], this._te('webcodecs'));
    const Info = new Blob([
      new Uint8Array([0x15,0x49,0xA9,0x66]),
      this._vintSize(TimecodeScale.size + MuxingApp.size + WritingApp.size),
      TimecodeScale, MuxingApp, WritingApp
    ]);

    // Segment (unknown length); append Info + Tracks; Clusters come later
    this.segment.push(
      EBML,
      new Uint8Array([0x18,0x53,0x80,0x67]), // Segment
      // Unknown size (all 0xFF) for streaming friendliness
      new Uint8Array([0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF]),
      Info, Tracks
    );
  }

  _startCluster() {
    // Cluster start at current absolute time in ms (rounded)
    this.clusterTimecode = Math.round(this.frameCount * (1000 / this.fps));
    const clusterHeader = new Blob([
      new Uint8Array([0x1F,0x43,0xB6,0x75]), // Cluster
      // Unknown size for Cluster (so we can stream-append blocks)
      new Uint8Array([0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF]),
      // Timecode (0xE7) stored as a 4-byte unsigned integer (safe for long videos)
      new Uint8Array([0xE7]), this._vintSize(4), this._u32(this.clusterTimecode)
    ]);
    this.cluster = [clusterHeader];
  }

  addFrame(data, key = false) {
    if (!this.cluster.length) this._startCluster();

    // Relative time within cluster in ms, 16-bit signed fits up to ~32s; we flush clusters well before that.
    const tcAbs = Math.round(this.frameCount * (1000 / this.fps));
    const tc = tcAbs - this.clusterTimecode; // 0 at start of cluster

    // SimpleBlock
    const block = new Blob([
      new Uint8Array([0xA3]), // SimpleBlock
      this._vintSize(1 + 2 + 1 + data.byteLength), // track(1) + timecode(2) + flags(1) + payload
      new Uint8Array([0x81]), // TrackNumber = 1 (vint for 1)
      this._u16(tc & 0xFFFF),
      new Uint8Array([ key ? 0x80 : 0x00 ]),
      new Uint8Array(data)
    ]);
    this.cluster.push(block);
    this.frameCount++;

    // Start a new cluster every ~5s to keep timecode deltas small and players happy.
    if (tc >= 5000) this._flushCluster();
  }

  _flushCluster() {
    if (this.cluster.length) {
      this.segment.push(...this.cluster);
      this.cluster = [];
    }
  }

  finalize() {
    this._flushCluster();
    return new Blob(this.segment, { type: 'video/webm' });
  }
}

function supportsWebCodecs() {
  return 'VideoEncoder' in window && 'VideoFrame' in window;
}

export class Exporter {
  constructor(canvas, renderer, state, els) {
    this.canvas = canvas;
    this.renderer = renderer;
    this.state = state;
    this.els = els;
    this.lastWebM = null;
  }

  async exportWebM() {
    if (!supportsWebCodecs()) {
      throw new Error('WebCodecs not supported in this browser.');
    }

    const fps = +this.state.settings.fps;
    const bitrate = Math.max(1_000_000, Math.round(+this.state.settings.bitrate || 8_000_000)); // bits/sec
    const w = this.canvas.width, h = this.canvas.height;

    // Encode all frames with WebCodecs VP9 (deterministic; fast)
    const encoded = [];
    const encoder = new VideoEncoder({
      output: chunk => encoded.push(chunk),
      error: e => console.error('VideoEncoder error:', e),
    });
    await encoder.configure({
      codec: 'vp09.00.10.08', // VP9 profile0
      width: w,
      height: h,
      bitrate,
      framerate: fps
    });

    const totalSec = this.state.totalDuration(false);
    const totalFrames = Math.max(1, Math.ceil(totalSec * fps));
    const prog = this.els?.progBar;
    const updateProg = (i) => prog && (prog.style.width = ((i / totalFrames) * 100).toFixed(1) + '%');

    for (let i = 0; i < totalFrames; i++) {
      const t = i / fps;
      this.renderer.drawAt(t, false);
      const vf = new VideoFrame(this.canvas, { timestamp: Math.round(1e6 * t) }); // µs timestamps
      encoder.encode(vf, { keyFrame: (i % (fps * 2)) === 0 }); // keyframe ~ every 2s
      vf.close();
      if ((i & 127) === 0) await waitNextFrame(); // yield periodically
      if ((i & 15) === 0) updateProg(i);
    }
    await encoder.flush();

    // Mux VP9 chunks into WebM
    const muxer = new WebMMuxer({ width: w, height: h, fps, codec: 'V_VP9' });
    for (const c of encoded) {
      const data = new Uint8Array(c.byteLength);
      c.copyTo(data);
      muxer.addFrame(data, c.type === 'key');
    }
    const webm = muxer.finalize();
    this.lastWebM = webm;

    await this._download(webm, this.fileName('webm'));
    updateProg(totalFrames);
    return webm;
  }

  fileName(ext) {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    return `slideshow-${stamp}.${ext}`;
  }
  _fileName(ext) { return this.fileName(ext); } // compat

  async _download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 4000);

    if (this.els?.dlArea) {
      const url = URL.createObjectURL(blob);
      this.els.dlArea.innerHTML = `If the download didn’t start, <a href="${url}" download="${name}">click to save ${name}</a>.`;
    }
  }
}
