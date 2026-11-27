// Puente con ExifTool (WebAssembly, carpeta exiftool/). Se descarga solo cuando hace falta.
const ExifT = (() => {
  const available = location.protocol !== 'file:';
  let module, queue = Promise.resolve();

  // De a una ejecución: el motor se comparte y consume bastante memoria
  function run(file, args) {
    if (!available) return Promise.reject(new Error('ExifTool solo funciona abriendo la app desde la web'));
    const job = queue.then(async () => {
      module ||= await import('./exiftool/exiftool.js');
      const result = await module.parseMetadata(file, { args, fetch: () => fetch('exiftool/zeroperl.wasm') });
      if (!result.success) throw new Error(String(result.error).trim() || 'ExifTool no pudo leer el archivo');
      return JSON.parse(result.data)[0];
    });
    queue = job.catch(() => {});
    return job;
  }

  // Imágenes embebidas, de mayor a menor. ExifTool entrega los datos binarios en base64 dentro del JSON.
  async function previews(file) {
    const data = await run(file, ['-j', '-b', '-JpgFromRaw', '-PreviewImage', '-OtherImage', '-ThumbnailImage']);
    return Object.values(data)
      .filter(v => typeof v === 'string' && v.startsWith('base64:'))
      .map(v => Uint8Array.from(atob(v.slice(7)), c => c.charCodeAt(0)))
      .filter(b => b[0] === 0xff && b[1] === 0xd8)
      .sort((a, b) => b.length - a.length)
      .map(b => ({ blob: new Blob([b], { type: 'image/jpeg' }), exif: Exif.parseBuffer(b.slice(0, 512 * 1024).buffer) }));
  }

  const metadata = file => run(file, ['-j', '-G1']);

  return { available, previews, metadata };
})();
