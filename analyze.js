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

  // Giro según la orientación EXIF (3: 180°, 6: 90°, 8: 270°)
  const TURNS = { 3: 2, 6: 1, 8: 3 };

  function render(bitmap, max, turns) {
    const k = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * k)), h = Math.max(1, Math.round(bitmap.height * k));
    const c = new OffscreenCanvas(turns % 2 ? h : w, turns % 2 ? w : h);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.translate(c.width / 2, c.height / 2);
    ctx.rotate(turns * Math.PI / 2);
    ctx.drawImage(bitmap, -w / 2, -h / 2, w, h);
    return { c, ctx };
  }

  // Si la vista previa trae su propia orientación, el navegador ya la aplica
  const turnsFor = (preview, exif) => preview.exif.orientation ? 0 : TURNS[exif.orientation] || 0;

  // Imagen para el visor: el archivo mismo, o la vista previa derecha si es RAW
  async function viewable(file, exif) {
    if (!Raw.is(file.name) && await opens(file)) return file;
    const own = Raw.is(file.name) ? await Raw.previews(file) : [];
    return await firstViewable(own, exif) || firstViewable(await ExifT.previews(file).catch(() => []), exif);
  }

  async function opens(source) {
    try { (await createImageBitmap(source)).close(); return true; } catch { return false; }
  }

  async function firstViewable(previews, exif) {
    for (const preview of previews) {
      let bitmap;
      try { bitmap = await createImageBitmap(preview.blob); } catch { continue; }
      const turns = turnsFor(preview, exif);
      const result = turns ? await render(bitmap, Infinity, turns).c.convertToBlob({ type: 'image/jpeg', quality: 0.92 }) : preview.blob;
      bitmap.close();
      return result;
    }
    return null;
  }

  async function image(source, turns = 0) {
    let bitmap;
    try {
      bitmap = await createImageBitmap(source);
    } catch {
      return null; // formato que el navegador no decodifica (HEIC, RAW)
    }
    const a = render(bitmap, ANALYSIS_SIZE, turns);
    const m = metrics(a.ctx.getImageData(0, 0, a.c.width, a.c.height).data, a.c.width, a.c.height);
    const thumb = await render(bitmap, THUMB_SIZE, turns).c.convertToBlob({ type: 'image/jpeg', quality: 0.75 });
    const result = { ...m, thumb, width: turns % 2 ? bitmap.height : bitmap.width, height: turns % 2 ? bitmap.width : bitmap.height };
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
    // Al cambiar la forma de analizar se sube la versión para no reutilizar resultados viejos
    key = `v3|${key}`;
    const cached = await cacheGet(key);
    if (cached) return cached;
    let exif = await Exif.read(file);
    let img = null, reason = null;
    const tryPreviews = async previews => {
      for (const preview of previews) {
        const result = await image(preview.blob, turnsFor(preview, exif));
        if (result) return result;
      }
      return null;
    };
    if (Raw.is(file.name)) {
      const previews = await Raw.previews(file);
      // Algunos formatos (Fuji RAF) solo exponen los datos dentro de la vista previa
      if (previews[0] && !exif.dateOriginal) exif = { ...previews[0].exif, ...exif };
      img = await tryPreviews(previews);
    } else {
      img = await image(file);
    }
    // Respaldo: lo que el lector rápido no pudo abrir se le pide a ExifTool
    if (!img) {
      try {
        img = await tryPreviews(await ExifT.previews(file));
        if (!img) reason = 'Ni el lector propio ni ExifTool encontraron una imagen que el navegador pueda abrir';
      } catch (e) {
        reason = `No se pudo usar ExifTool: ${e.message}`;
      }
    }
    const result = { exif, img, reason };
    // Los fallos no se guardan: pueden ser pasajeros (falta de memoria) y se reintentan al reabrir
    if (img) cachePut(key, result);
    return result;
  }

  return { photo, metrics, viewable };
})();
