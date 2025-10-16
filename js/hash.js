// hash.js — exact (SHA-256) and perceptual (aHash) hashing helpers
export async function sha256Hex(buf){
  const ab = buf instanceof ArrayBuffer ? buf : await buf.arrayBuffer();
  const hash = await crypto.subtle.digest('SHA-256', ab);
  const b = new Uint8Array(hash);
  return [...b].map(x=>x.toString(16).padStart(2,'0')).join('');
}

export function aHashFromCanvas(canvas){
  const w = 8, h = 8;
  const off = document.createElement('canvas');
  off.width = w; off.height = h;
  const ictx = off.getContext('2d', { willReadFrequently:true });
  ictx.drawImage(canvas, 0, 0, w, h);
  const { data } = ictx.getImageData(0,0,w,h);
  const grays = [];
  for (let i=0;i<data.length;i+=4){
    const g = Math.round(0.299*data[i] + 0.587*data[i+1] + 0.114*data[i+2]);
    grays.push(g);
  }
  const avg = grays.reduce((a,b)=>a+b,0)/grays.length;
  let bits = 0n;
  for (let i=0;i<grays.length;i++){
    bits = (bits<<1n) | (grays[i] >= avg ? 1n : 0n);
  }
  return bits;
}

export function hammingDistance64(a,b){
  let x = a ^ b;
  let count = 0;
  while (x){
    x &= (x - 1n);
    count++;
  }
  return count;
}
