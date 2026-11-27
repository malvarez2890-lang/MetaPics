// Lector de metadatos EXIF sin dependencias: JPEG, TIFF/RAW basados en TIFF, PNG, WebP y HEIC.
const Exif = (() => {
  const TAGS = {
    0x010f: 'make', 0x0110: 'model', 0x0112: 'orientation', 0x0131: 'software', 0x0132: 'modifyDate',
    0x829a: 'exposureTime', 0x829d: 'fNumber', 0x8827: 'iso', 0x9003: 'dateOriginal', 0x9004: 'dateDigitized',
    0x9204: 'exposureBias', 0x9209: 'flash', 0x920a: 'focalLength', 0xa002: 'width', 0xa003: 'height',
    0xa434: 'lens'
  };
  const GPS = { 1: 'latRef', 2: 'lat', 3: 'lonRef', 4: 'lon' };
  const SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

  function parseTiff(view, start, out) {
    if (start + 8 > view.byteLength) return false;
    const order = view.getUint16(start);
    if (order !== 0x4949 && order !== 0x4d4d) return false;
    const le = order === 0x4949;
    const u16 = o => view.getUint16(o, le);
    const u32 = o => view.getUint32(o, le);
    if (u16(start + 2) !== 42) return false;
    const seen = new Set();

    function value(type, count, pos) {
      if (type === 2) {
        let s = '';
        for (let i = 0; i < count; i++) {
          const c = view.getUint8(pos + i);
          if (!c) break;
          s += String.fromCharCode(c);
        }
        return s.trim();
      }
      const arr = [];
      for (let i = 0; i < Math.min(count, 8); i++) {
        const p = pos + i * SIZE[type];
        if (type === 3) arr.push(u16(p));
        else if (type === 4) arr.push(u32(p));
        else if (type === 9) arr.push(view.getInt32(p, le));
        else if (type === 5) arr.push(u32(p + 4) ? u32(p) / u32(p + 4) : 0);
        else if (type === 10) arr.push(view.getInt32(p + 4, le) ? view.getInt32(p, le) / view.getInt32(p + 4, le) : 0);
        else arr.push(view.getUint8(p));
      }
      return count === 1 ? arr[0] : arr;
    }

    function ifd(offset, names) {
      const base = start + offset;
      if (seen.has(base) || base + 2 > view.byteLength) return;
      seen.add(base);
      const n = u16(base);
      for (let i = 0; i < n; i++) {
        const e = base + 2 + i * 12;
        if (e + 12 > view.byteLength) return;
        const tag = u16(e), type = u16(e + 2), count = u32(e + 4);
        if (!SIZE[type]) continue;
        const bytes = SIZE[type] * count;
        const pos = bytes <= 4 ? e + 8 : start + u32(e + 8);
        if (pos + Math.min(bytes, 8 * SIZE[type]) > view.byteLength) continue;
        if (names === TAGS && tag === 0x8769) ifd(u32(e + 8), TAGS);
        else if (names === TAGS && tag === 0x8825) ifd(u32(e + 8), GPS);
        else if (names[tag] && (type !== 2 || pos + bytes <= view.byteLength)) out[names[tag]] = value(type, count, pos);
      }
    }
    ifd(u32(start + 4), TAGS);
    return true;
  }

  const ascii = (view, o, n) => {
    let s = '';
    for (let i = 0; i < n && o + i < view.byteLength; i++) s += String.fromCharCode(view.getUint8(o + i));
    return s;
  };

  function parseJpeg(view, out) {
    let o = 2;
    while (o + 4 <= view.byteLength) {
      if (view.getUint8(o) !== 0xff) break;
      const marker = view.getUint8(o + 1);
      if (marker === 0xff) { o++; continue; }
      if (marker === 0xda || marker === 0xd9) break;
      const len = view.getUint16(o + 2);
      if (marker === 0xe1 && ascii(view, o + 4, 4) === 'Exif') parseTiff(view, o + 10, out);
      // Marcadores SOF: dimensiones reales de la imagen
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker) && o + 9 <= view.byteLength) {
        out.height = view.getUint16(o + 5);
        out.width = view.getUint16(o + 7);
      }
      o += 2 + len;
    }
  }

  // HEIC y otros contenedores: buscar la cabecera "Exif\0\0" seguida de TIFF
  function scan(view, out) {
    for (let i = 0; i + 14 < view.byteLength; i++) {
      if (view.getUint8(i) !== 0x45 || view.getUint32(i) !== 0x45786966 || view.getUint16(i + 4) !== 0) continue;
      if (parseTiff(view, i + 6, out)) return true;
    }
    return false;
  }

  function parseBuffer(buf) {
    const view = new DataView(buf);
    const out = {};
    if (view.byteLength < 12) return out;
    if (view.getUint16(0) === 0xffd8) parseJpeg(view, out);
    else if (view.getUint16(0) === 0x4949 || view.getUint16(0) === 0x4d4d) parseTiff(view, 0, out);
    else if (view.getUint32(0) === 0x89504e47) {
      let o = 8;
      while (o + 12 <= view.byteLength) {
        const len = view.getUint32(o);
        if (ascii(view, o + 4, 4) === 'eXIf') parseTiff(view, o + 8, out);
        o += 12 + len;
      }
    } else if (ascii(view, 0, 4) === 'RIFF') {
      let o = 12;
      while (o + 8 <= view.byteLength) {
        const len = view.getUint32(o + 4, true);
        if (ascii(view, o, 4) === 'EXIF') parseTiff(view, ascii(view, o + 8, 4) === 'Exif' ? o + 14 : o + 8, out);
        o += 8 + len + (len & 1);
      }
    } else scan(view, out);
    return out;
  }

  async function read(file) {
    const isContainer = /\.(heic|heif|avif)$/i.test(file.name);
    let data = {};
    try {
      data = parseBuffer(await file.slice(0, 512 * 1024).arrayBuffer());
      // En HEIC y RAW el bloque EXIF puede estar más adelante en el archivo
      const needsAll = !data.dateOriginal && !data.model && (isContainer || /\.(tif|tiff|dng|cr2|nef|arw)$/i.test(file.name));
      if (needsAll && file.size > 512 * 1024) data = parseBuffer(await file.arrayBuffer());
    } catch (e) {
      console.warn('EXIF ilegible en', file.name, e);
    }
    return data;
  }

  return { read, parseBuffer };
})();
