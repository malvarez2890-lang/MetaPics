// Archivos RAW de cámaras: se usa la vista previa JPEG que la propia cámara guarda adentro.
const Raw = (() => {
  const RE = /\.(nef|nrw|cr2|cr3|arw|sr2|dng|raf|orf|rw2|pef|srw)$/i;
  const is = name => RE.test(name);

  // Dimensiones de un JPEG que empieza en "start"; null si no es una imagen que el navegador pueda abrir
  function jpegSize(u, start) {
    let o = start + 2;
    while (o + 9 <= u.length) {
      if (u[o] !== 0xff) return null;
      const m = u[o + 1];
      if (m === 0xff) { o++; continue; }
      if (m === 0xd9 || m === 0xda) return null;
      const len = (u[o + 2] << 8) | u[o + 3];
      if (len < 2) return null;
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        // Los tipos posteriores a C2 son los datos sin pérdida del sensor, no una vista previa
        return m > 0xc2 ? null : { height: (u[o + 5] << 8) | u[o + 6], width: (u[o + 7] << 8) | u[o + 8] };
      }
      o += 2 + len;
    }
    return null;
  }

  // Devuelve la vista previa más grande: { blob, width, height, exif } o null
  async function preview(file) {
    const u = new Uint8Array(await file.arrayBuffer());
    let best = null;
    for (let i = u.indexOf(0xff); i !== -1; i = u.indexOf(0xff, i + 1)) {
      if (u[i + 1] !== 0xd8 || u[i + 2] !== 0xff) continue;
      const size = jpegSize(u, i);
      if (size && (!best || size.width * size.height > best.width * best.height)) best = { offset: i, ...size };
    }
    if (!best) return null;
    return {
      blob: file.slice(best.offset, file.size, 'image/jpeg'),
      width: best.width,
      height: best.height,
      exif: Exif.parseBuffer(u.slice(best.offset, best.offset + 512 * 1024).buffer)
    };
  }

  return { is, preview };
})();
