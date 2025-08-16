// exporter.js — WebM export in-browser + hooks for Electron MP4 (H.264/AAC)
// ---------------------------------------------------------------------------------
// Usage (browser):
//   const exporter = new Exporter(canvas, renderer, state, els)
//   await exporter.exportWebM(); // prompts WebM download
//
// Usage (Electron MP4):
//   // call this from the renderer after wiring a preload API (see notes below)
//   await exporter.exportMP4Electron('standard');
//
// NOTES:
// - This records the canvas in *real time* at the chosen FPS, stepping the
//   renderer by a fixed dt per frame for stable motion & transitions.
// - Quality presets map to bitrates and scale with resolution.

export class Exporter {
  /** @param {HTMLCanvasElement} canvas @param {import('./renderer.js').Renderer} renderer @param {ReturnType<import('./state.js').createState>} state @param {{status?:HTMLElement, progBar?:HTMLElement}} els */
  constructor(canvas, renderer, state, els){
    this.canvas = canvas;
    this.renderer = renderer;
    this.state = state;
    this.els = els || {};
  }

  // ----------------------------- Public API ---------------------------------
  async exportWebM(){
    const pages = this.state.pageCount();
    if (!pages) { this._setStatus('Please add photos before exporting.'); return; }

    const fps = this.state.settings.fps|0 || 30;
    const dur = this.state.totalDuration(false);
    const mime = this._pickMime();
    if (!mime){ this._setStatus('Export unsupported in this browser. Try desktop Chrome.'); return; }

    const bitrate = this._bitrateFromPresetOrSetting();

    this._setStatus(`Rendering ${this._fmtTime(dur)} at ${fps} fps…`);

    const blob = await this._recordWebM({ fps, duration: dur, bitrate, mime });
    const url = URL.createObjectURL(blob);
    const name = this._defaultFileName('webm');
    this._download(url, name);
    this._setStatus('Done. Download should start automatically.');
    this._setProgress(0);
  }

  async exportWebMToBuffer(){
    const fps = this.state.settings.fps|0 || 30;
    const dur = this.state.totalDuration(false);
    const mime = this._pickMime();
    if (!mime) throw new Error('MediaRecorder/WebM not supported');
    const bitrate = this._bitrateFromPresetOrSetting();
    const blob = await this._recordWebM({ fps, duration: dur, bitrate, mime });
    return await blob.arrayBuffer();
  }

  // Electron hook: convert to MP4 via ffmpeg in main process
  // Requires a preload exposing: window.electronAPI.convertWebMToMP4(buffer, opts)
  // where opts = { width, height, fps, bitrate, crf, addSilentAudio }
  async exportMP4Electron(preset='standard'){
    if (!window.electronAPI || typeof window.electronAPI.convertWebMToMP4 !== 'function'){
      throw new Error('Electron bridge not found. Implement preload: electronAPI.convertWebMToMP4');
    }
    const buffer = await this.exportWebMToBuffer();
    const { width, height } = this.canvas;
    const fps = this.state.settings.fps|0 || 30;
    const { videoBitrate, crf } = this._presetParams(preset, width, height, fps);

    this._setStatus(`Converting to MP4 (${preset})…`);
    const outPath = await window.electronAPI.convertWebMToMP4(buffer, {
      width, height, fps, bitrate: videoBitrate, crf, addSilentAudio: true
    });
    this._setStatus(`MP4 saved: ${outPath}`);
    return outPath;
  }

  // ----------------------------- Internals ----------------------------------
  _pickMime(){
    const list = ['video/webm;codecs=vp9','video/webm;codecs=vp8','video/webm'];
    for (const m of list){ if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m; }
    return '';
  }

  _presetParams(preset, w, h, fps){
    // Scales bitrates relative to 1080p@30 using area ratio
    const area = w*h, baseArea = 1920*1080;
    const scale = Math.max(0.5, area / baseArea) * Math.max(0.8, fps/30);
    const table = {
      social:   { videoBitrate: 5_000_000,  crf: 23 },  // small socials
      standard: { videoBitrate: 8_000_000,  crf: 21 },  // default
      high:     { videoBitrate: 12_000_000, crf: 19 },  // cleaner
      insane:   { videoBitrate: 20_000_000, crf: 18 },  // near mezzanine
    };
    const base = table[preset] || table.standard;
    return { videoBitrate: Math.round(base.videoBitrate * scale), crf: base.crf };
  }

  _bitrateFromPresetOrSetting(){
    // Honor explicit slider first; otherwise choose by resolution using 'standard'
    const b = this.state.settings.bitrate|0;
    if (b > 0) return b;
    const { width:w, height:h } = this.canvas; const fps = this.state.settings.fps|0 || 30;
    return this._presetParams('standard', w, h, fps).videoBitrate;
  }

  async _recordWebM({ fps, duration, bitrate, mime }){
    const stream = this.canvas.captureStream(fps);
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: bitrate });
    const chunks = [];

    const done = new Promise((resolve, reject)=>{
      rec.ondataavailable = e=>{ if (e.data && e.data.size) chunks.push(e.data); };
      rec.onstop = ()=> resolve(new Blob(chunks, { type: mime }));
      rec.onerror = e=> reject(e.error || new Error('MediaRecorder error'));
    });

    rec.start();

    // Drive the renderer at fixed fps; non-looping timeline for export
    const totalFrames = Math.max(1, Math.ceil(duration * fps));
    const dt = 1 / fps;
    let frame = 0; let t = 0;

    await new Promise((resolve)=>{
      const tick = ()=>{
        // Draw current frame
        this.renderer.drawAt(t, /*loop*/ false);
        // Advance time for next frame
        t += dt; frame++;
        const pct = Math.min(100, Math.round((frame/totalFrames)*100));
        this._setProgress(pct);
        if (frame >= totalFrames){ resolve(); return; }
        // Use setTimeout to target frame pacing without starving main thread
        setTimeout(tick, Math.max(0, Math.round(1000/fps) - 2));
      };
      tick();
    });

    // Stop recording after a short drain delay so the last frame is flushed
    await new Promise(r => setTimeout(r, 200));
    rec.stop();

    const blob = await done;
    return blob;
  }

  _download(url, name){
    const a = document.createElement('a'); a.href = url; a.download = name; a.style.display='none';
    document.body.appendChild(a); a.click(); setTimeout(()=>{ a.remove(); URL.revokeObjectURL(url); }, 1000);
  }

  _defaultFileName(ext){
    const w=this.canvas.width, h=this.canvas.height, fps=this.state.settings.fps|0||30;
    const ts = new Date().toISOString().replace(/[:.]/g,'-');
    return `slideshow_${w}x${h}_${fps}fps_${ts}.${ext}`;
  }

  _setStatus(msg){ if (this.els.status) this.els.status.textContent = msg; }
  _setProgress(pct){ if (this.els.progBar) this.els.progBar.style.width = `${pct}%`; }
  _fmtTime(sec){ const m=Math.floor(sec/60)|0, s=Math.round(sec%60)|0; return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`; }
}

/* ---------------------------------------------------------------------------
   ELECTRON BRIDGE (to implement in your app later)
   ---------------------------------------------------------------------------
   // preload.js
   const { contextBridge, ipcRenderer } = require('electron');
   contextBridge.exposeInMainWorld('electronAPI', {
     convertWebMToMP4: (arrayBuffer, opts) => ipcRenderer.invoke('convert-webm-to-mp4', arrayBuffer, opts)
   });

   // main.js (sketch)
   const { app, BrowserWindow, ipcMain } = require('electron');
   const { spawn } = require('child_process');
   const path = require('path'); const fs = require('fs');
   ipcMain.handle('convert-webm-to-mp4', async (e, arrayBuffer, opts)=>{
     const tmpIn  = path.join(app.getPath('temp'), `in_${Date.now()}.webm`);
     const outDir = app.getPath('videos');
     const out    = path.join(outDir, `slideshow_${opts.width}x${opts.height}_${Date.now()}.mp4`);
     fs.writeFileSync(tmpIn, Buffer.from(arrayBuffer));
     // Build ffmpeg args
     const args = [
       '-y', '-i', tmpIn,
       ...(opts.addSilentAudio? ['-f','lavfi','-t', String(Math.max(1, Math.ceil((opts.duration||0)))),'-i','anullsrc=channel_layout=stereo:sample_rate=48000']: []),
       '-c:v','libx264','-pix_fmt','yuv420p','-preset','veryfast',
       ...(opts.crf? ['-crf', String(opts.crf)]: []),
       ...(opts.bitrate? ['-b:v', String(opts.bitrate)]: []),
       '-movflags','+faststart', out
     ];
     await new Promise((res, rej)=>{
       const ff = spawn('ffmpeg', args, { windowsHide:true });
       ff.on('exit', code=> code===0? res(): rej(new Error('ffmpeg failed '+code)));
     });
     try{ fs.unlinkSync(tmpIn); }catch{}
     return out;
   });
*/
