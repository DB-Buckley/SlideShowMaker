// exporter.js — Reliable WebM export via MediaRecorder + canvas.captureStream
// - Prefer VP8 for maximum stability, fall back to VP9/generic webm.
// - Timesliced recording + requestData() to force regular flushing.
// - rAF-driven fixed-FPS renderer (robust against setTimeout jitter).
// - Watchdog that fails fast if the recorder doesn't flush.

import { waitNextFrame } from './utils.js';

function supportsRecorder() {
  return typeof MediaRecorder !== 'undefined' &&
         typeof HTMLCanvasElement.prototype.captureStream === 'function';
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
    if (!supportsRecorder()) {
      throw new Error('This browser does not support MediaRecorder or canvas.captureStream for WebM.');
    }

    const fps = Math.max(1, Math.floor(+this.state.settings.fps || 30));
    const bitrate = Math.max(2_000_000, Math.round(+this.state.settings.bitrate || 8_000_000)); // bits/s
    const totalSec = this.state.totalDuration(false);
    if (!(totalSec > 0)) throw new Error('No duration to export. Add photos first.');

    // Prefer VP8 → most reliable across Chrome/Firefox; then VP9; then generic.
    const mimeCandidates = [
      'video/webm;codecs=vp8',
      'video/webm;codecs=vp9',
      'video/webm'
    ];
    let mimeType = '';
    for (const m of mimeCandidates) {
      if (MediaRecorder.isTypeSupported(m)) { mimeType = m; break; }
    }
    if (!mimeType) throw new Error('No supported WebM mime type found for MediaRecorder.');

    // Capture the canvas stream at target fps
    const stream = this.canvas.captureStream(fps);
    const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: bitrate });

    const chunks = [];
    let bytesSoFar = 0;
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size) {
        chunks.push(e.data);
        bytesSoFar += e.data.size;
      }
    };

    // Progress UI
    const totalFrames = Math.max(1, Math.ceil(totalSec * fps));
    const prog = this.els?.progBar;
    const updateProg = (i) => { if (prog) prog.style.width = ((i / totalFrames) * 100).toFixed(1) + '%'; };

    // Promises controlling start/stop
    const started = new Promise((resolve) => { recorder.onstart = resolve; });
    const stopped = new Promise((resolve, reject) => {
      recorder.onerror = (e) => reject(e?.error || e);
      recorder.onstop  = () => resolve(new Blob(chunks, { type: mimeType }));
    });

    // Timeslice & forced flush
    const TIME_SLICE_MS = 1000;             // chunk every second
    const FLUSH_EVERY_MS = 1000;            // requestData every second too (belt-and-braces)
    let flushTimer = null;

    recorder.start(TIME_SLICE_MS);          // important: time-sliced recording
    await started;

    flushTimer = setInterval(() => {
      try { if (recorder.state === 'recording') recorder.requestData(); } catch {}
    }, FLUSH_EVERY_MS);

    // rAF-driven fixed-fps render loop for reliability
    const frameInterval = 1000 / fps;
    const tStart = performance.now();
    let nextFrameTime = tStart;
    let frameIndex = 0;

    const loop = async () => {
      // Draw frames until we reach totalFrames
      while (frameIndex < totalFrames) {
        const now = performance.now();
        if (now >= nextFrameTime) {
          const t = frameIndex / fps;             // timeline seconds
          this.renderer.drawAt(t, false);
          frameIndex++;
          if ((frameIndex & 7) === 0) updateProg(frameIndex);
          nextFrameTime += frameInterval;
        } else {
          await new Promise(r => requestAnimationFrame(r));
        }
      }
    };

    await loop();

    // Ensure exact last frame + a tiny tail to flush encoder
    this.renderer.drawAt(totalSec, false);
    await new Promise(r => setTimeout(r, Math.max(10, frameInterval / 2)));

    // Stop recording and wait for final blob
    recorder.stop();

    // Watchdog: fail fast if data never arrives
    const WATCHDOG_MS = Math.max(5000, Math.ceil(totalSec * 1500)); // generous: 1.5× duration, min 5s
    const watchdog = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Recorder did not finalize the WebM in time.')), WATCHDOG_MS)
    );

    let webmBlob;
    try {
      webmBlob = await Promise.race([stopped, watchdog]);
    } finally {
      if (flushTimer) clearInterval(flushTimer);
    }

    if (!webmBlob || !webmBlob.size) {
      const msg = bytesSoFar ? 'Recorder finalized empty blob after receiving chunks.' : 'Recorder produced no chunks.';
      throw new Error('Export failed: ' + msg);
    }

    this.lastWebM = webmBlob;
    await this._download(webmBlob, this.fileName('webm'));
    updateProg(totalFrames);
    return webmBlob;
  }

  fileName(ext) {
    const stamp = new Date().toISOString().slice(0,19).replace(/[:T]/g,'-');
    return `slideshow-${stamp}.${ext}`;
  }
  _fileName(ext){ return this.fileName(ext); } // compat

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
