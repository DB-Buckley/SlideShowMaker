// exif.js — minimal EXIF orientation reader (JPEG only). Returns 1..8 or 1 if not found.
export async function readExifOrientation(fileOrBuffer){
  let buf;
  if (fileOrBuffer instanceof ArrayBuffer) buf = fileOrBuffer;
  else buf = await fileOrBuffer.arrayBuffer();

  const dv = new DataView(buf);
  if (dv.getUint16(0) !== 0xFFD8) return 1; // not JPEG
  let offset = 2;
  const length = dv.byteLength;
  while (offset < length){
    const marker = dv.getUint16(offset); offset += 2;
    if (marker === 0xFFE1){ // APP1
      const size = dv.getUint16(offset); offset += 2;
      if (dv.getUint32(offset) === 0x45786966){ // "Exif"
        offset += 6; // skip "Exif\0\0"
        const tiffOff = offset;
        const endian = dv.getUint16(tiffOff);
        const little = endian === 0x4949;
        const getU16 = (o)=> little? dv.getUint16(o, true) : dv.getUint16(o, false);
        const getU32 = (o)=> little? dv.getUint32(o, true) : dv.getUint32(o, false);
        const ifd0 = tiffOff + getU32(tiffOff + 4);
        const entries = getU16(ifd0);
        for (let i=0;i<entries;i++){
          const entry = ifd0 + 2 + i*12;
          const tag = getU16(entry);
          if (tag === 0x0112){ // Orientation
            const val = getU16(entry + 8);
            return val || 1;
          }
        }
      }else{
        offset += size - 2;
      }
    } else {
      const size = dv.getUint16(offset); offset += size;
    }
  }
  return 1;
}

// draw with orientation into a target rect
export function drawWithOrientation(ctx, img, orientation, dstW, dstH){
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  const scale = Math.max(dstW / w, dstH / h);
  const dw = w * scale;
  const dh = h * scale;
  ctx.save();
  switch(orientation){
    case 2: ctx.translate(dstW, 0); ctx.scale(-1, 1); break;
    case 3: ctx.translate(dstW, dstH); ctx.rotate(Math.PI); break;
    case 4: ctx.translate(0, dstH); ctx.scale(1, -1); break;
    case 5: ctx.rotate(0.5*Math.PI); ctx.scale(1, -1); ctx.translate(0, -dstH); break;
    case 6: ctx.translate(dstW, 0); ctx.rotate(0.5*Math.PI); break;
    case 7: ctx.translate(dstW, 0); ctx.rotate(0.5*Math.PI); ctx.scale(1, -1); break;
    case 8: ctx.translate(0, dstH); ctx.rotate(-0.5*Math.PI); break;
    default: break;
  }
  const ox = (dstW - dw) / 2;
  const oy = (dstH - dh) / 2;
  ctx.drawImage(img, ox, oy, dw, dh);
  ctx.restore();
}
