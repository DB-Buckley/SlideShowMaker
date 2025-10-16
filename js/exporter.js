// exporter.js — MP4-only export (MediaRecorder). Clear fallback if unsupported.
import { waitNextFrame } from './utils.js';

function supportsMp4Recorder() {
  return typeof MediaRecorder !== 'undefined' &&
         MediaRecorder.isTypeSupported &&
         MediaRecorder.isTypeSupported('video/mp4;codecs=avc1.42E01E');
}

export class Exporter{
  constructor(canvas, renderer, state, els){
    this.canvas = canvas;
    this.renderer = renderer;
    this.state = state;
    this.els = els;
  }

  async export(){
    if (supportsMp4Recorder()){
      return await this._exportMp4MediaRecorder();
    } else {
      // Clear message and helper if MP4 isn’t available in this browser.
      const msg = [
        'MP4 export is not supported in this browser.',
        'Try Safari (macOS/iOS) or another browser that supports MediaRecorder MP4.',
        'Alternatively, save WebM and convert to MP4.'
      ].join(' ');
      console.warn(msg);
      if (this.els && this.els.dlArea){
        // Offer a WebM export + conversion tip so users never get stuck.
        this.els.dlArea.innerHTML = `
          <div style="margin-top:8px">
            <b>MP4 not available here.</b>
            <button id="exportWebMBtn" class="btn" style="margin-left:8px">Export WebM</button>
            <div class="help" style="margin-top:6px">
              Convert WebM → MP4 e.g.:
              <code>ffmpeg -i input.webm -c:v libx264 -crf 18 -preset veryfast output.mp4</code>
            </div>
          </div>`;
        const alt = document.getElementById('exportWebMBtn');
        if (alt){
          alt.onclick = async ()=>{
            const blob = await this._exportWebMRecorder();
            await this._download(blob, this._fileName('webm'));
          };
        }
      }
      throw new Error('MP4 MediaRecorder not supported in this browser.');
    }
  }

  async _exportMp4MediaRecorder(){
    const fps = this.state.settings.fps;
    const bits = this.state.settings.bitrate; // already in bps
    const mime = 'video/mp4;codecs=avc1.42E01E';

    const stream = this.canvas.captureStream(fps);
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: bits });
    const chunks = [];
    rec.ondataavailable = e=> { if (e.data && e.data.size) chunks.push(e.data); };

    const total = this.state.totalDuration(false);
    rec.start();

    const started = performance.now();
    const tick = ()=>{
      const t = (performance.now()-started)/1000;
      if (t >= total){ rec.stop(); return; }
      this.renderer.drawAt(t, false);
      requestAnimationFrame(tick);
    };
    tick();

    await new Promise(res=> rec.onstop = res);
    const blob = new Blob(chunks, { type: 'video/mp4' });
    await this._download(blob, this._fileName('mp4'));
    return blob;
  }

  // WebM helper for the fallback button
  async _exportWebMRecorder(){
    const fps = this.state.settings.fps;
    const bits = this.state.settings.bitrate;
    const mime = 'video/webm;codecs=vp9';

    const stream = this.canvas.captureStream(fps);
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: bits });
    const chunks = [];
    rec.ondataavailable = e=> { if (e.data && e.data.size) chunks.push(e.data); };

    const total = this.state.totalDuration(false);
    rec.start();

    const started = performance.now();
    const tick = ()=>{
      const t = (performance.now()-started)/1000;
      if (t >= total){ rec.stop(); return; }
      this.renderer.drawAt(t, false);
      requestAnimationFrame(tick);
    };
    tick();

    await new Promise(res=> rec.onstop = res);
    return new Blob(chunks, { type: 'video/webm' });
  }

  _fileName(ext){
    const stamp = new Date().toISOString().slice(0,19).replace(/[:T]/g,'-');
    return `slideshow-${stamp}.${ext}`;
  }

  async _download(blob, name){
    // Try the file picker first (great UX), then anchor fallback
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
    }catch(e){
      console.warn('showSaveFilePicker failed:', e);
    }

    // Anchor fallback
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
