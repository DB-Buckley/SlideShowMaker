// exporter.js — Robust WebM export using MediaRecorder + canvas.captureStream
// - Browser builds the WebM container (max compatibility)
// - Deterministic-ish by driving our own fixed-fps render loop
// - No ffmpeg, no headers, no COI. Pure client-side.

import { waitNextFrame } from './utils.js';

function supportsRecorder() {
  return typeof MediaRecorder !== 'undefined' && typeof HTMLCanvasElement.prototype.captureStream === 'function';
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

    // Prepare recorder
    const stream = this.canvas.captureStream(fps);
    const mimeCandidates = [
      'video/webm;codecs=vp9',
      'video/webm;codecs=vp8',
      'video/webm'
    ];
    let mimeType = '';
    for (const m of mimeCandidates) {
      if (MediaRecorder.isTypeSupported(m)) { mimeType = m; break; }
    }
    if (!mimeType) throw new Error('No supported WebM mime type found for MediaRecorder.');

    const recorder = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: bitrate
    });

    const chunks = [];
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };

    const prog = this.els?.progBar;
    const updateProg = (i, totalFrames) => { if (prog) prog.style.width = ((i / totalFrames) * 100).toFixed(1) + '%'; };

    const startPromise = new Promise((resolve) => {
      recorder.onstart = resolve;
    });
    const stopPromise = new Promise((resolve, reject) => {
      recorder.onerror = (e) => reject(e.error || e);
      recorder.onstop = () => resolve(new Blob(chunks, { type: mimeType }));
    });

    recorder.start(); // start recording immediately
    await startPromise;

    // Drive a fixed-fps render loop for the exact duration
    const totalFrames = Math.max(1, Math.ceil(totalSec * fps));
    const frameDelay = 1000 / fps;

    let t = 0;
    for (let i = 0; i < totalFrames; i++) {
      t = i / fps;
      this.renderer.drawAt(t, false);
      // yield stable pacing
      await new Promise(r => setTimeout(r, frameDelay));
      if ((i & 7) === 0) updateProg(i, totalFrames);
    }

    // Draw the very last frame to ensure exact duration end-frame is present
    this.renderer.drawAt(totalSec, false);
    await new Promise(r => setTimeout(r, frameDelay / 2));

    recorder.stop();
    const webmBlob = await stopPromise;

    if (!webmBlob || !webmBlob.size) {
      throw new Error('Recorder produced an empty WebM. Try a different browser or enable WebM/VP9.');
    }

    this.lastWebM = webmBlob;

    await this._download(webmBlob, this.fileName('webm'));
    updateProg(totalFrames, totalFrames);
    return webmBlob;
  }

  fileName(ext) {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    return `slideshow-${stamp}.${ext}`;
  }
  _fileName(ext) { return this.fileName(ext); } // compat for older calls

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
