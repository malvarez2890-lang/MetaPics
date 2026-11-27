// Análisis de píxeles (exposición y nitidez), miniaturas y caché en IndexedDB.
const Analyze = (() => {
  const ANALYSIS_SIZE = 512;
  const THUMB_SIZE = 280;

  function metrics(data, w, h) {
    const gray = new Float32Array(w * h);
    let burnt = 0, black = 0, sum = 0;
    for (let i = 0; i < w * h; i++) {
      const y = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
      gray[i] = y;
      sum += y;
      if (y >= 250) burnt++;
      if (y <= 5) black++;
    }
    // Nitidez: varianza del Laplaciano
    let s = 0, s2 = 0, n = 0;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        const l = gray[i - 1] + gray[i + 1] + gray[i - w] + gray[i + w] - 4 * gray[i];
        s += l; s2 += l * l; n++;
      }
    }
    return {
      burn: 100 * burnt / (w * h),
      black: 100 * black / (w * h),
      light: sum / (w * h),
      sharp: n ? s2 / n - (s / n) ** 2 : 0
    };
  }

  async function image(file) {
    let bitmap;
    try {
      bitmap = await createImageBitmap(file);
    } catch {
      return null; // formato que el navegador no decodifica (HEIC, RAW)
    }
    const draw = max => {
      const k = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
      const c = new OffscreenCanvas(Math.max(1, Math.round(bitmap.width * k)), Math.max(1, Math.round(bitmap.height * k)));
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(bitmap, 0, 0, c.width, c.height);
      return { c, ctx };
    };
    const a = draw(ANALYSIS_SIZE);
    const m = metrics(a.ctx.getImageData(0, 0, a.c.width, a.c.height).data, a.c.width, a.c.height);
    const thumb = await draw(THUMB_SIZE).c.convertToBlob({ type: 'image/jpeg', quality: 0.75 });
    const result = { ...m, thumb, width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return result;
  }

  // Caché: reabrir una carpeta grande no vuelve a analizar todo
  let dbPromise;
  function db() {
    dbPromise ||= new Promise(resolve => {
      const req = indexedDB.open('organizador-fotos', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('analysis');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    });
    return dbPromise;
  }
  async function cacheGet(key) {
    const d = await db();
    if (!d) return null;
    return new Promise(resolve => {
      const r = d.transaction('analysis').objectStore('analysis').get(key);
      r.onsuccess = () => resolve(r.result || null);
      r.onerror = () => resolve(null);
    });
  }
  async function cachePut(key, value) {
    const d = await db();
    if (!d) return;
    try { d.transaction('analysis', 'readwrite').objectStore('analysis').put(value, key); }
    catch (e) { console.warn('No se pudo guardar en caché', e); }
  }

  async function photo(file, key) {
    const cached = await cacheGet(key);
    if (cached) return cached;
    const exif = await Exif.read(file);
    const img = await image(file);
    const result = { exif, img };
    cachePut(key, result);
    return result;
  }

  return { photo, metrics };
})();
