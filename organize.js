// Armado de rutas y copia/movimiento seguro de archivos. Nunca sobrescribe.
const Organize = (() => {
  const MONTHS = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
  const pad = n => String(n).padStart(2, '0');
  const clean = s => String(s).replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').replace(/[. ]+$/, '').trim() || 'Sin dato';

  function plan(photos, opts) {
    return photos.map(p => {
      // Sin fecha de toma no se archiva por la fecha del archivo, que suele ser la de descarga o copia
      const d = p.estimated ? null : p.date;
      const vars = {
        'año': d ? d.getFullYear() : 'Sin fecha',
        mes: d ? `${pad(d.getMonth() + 1)} ${MONTHS[d.getMonth()]}` : 'Sin fecha',
        dia: d ? pad(d.getDate()) : 'Sin fecha',
        hora: d ? `${pad(d.getHours())}h` : 'Sin hora',
        franja: p.slot,
        calidad: p.quality,
        camara: p.camera,
        estrellas: p.stars ? `${p.stars} estrellas` : 'Sin estrellas',
        metadatos: p.metaLevel
      };
      // En nombres como {año}-{mes}-{dia} el mes va solo en número
      let folders = opts.template.split('/')
        .map(part => {
          if (!d && /\{(año|mes|dia|hora)\}/.test(part)) return 'Sin fecha';
          if (d) part = part.replace(/\{año\}-\{mes\}/g, `{año}-${pad(d.getMonth() + 1)}`);
          return part.replace(/\{([^}]+)\}/g, (m, k) => k in vars ? vars[k] : m);
        })
        .filter(part => part.trim())
        .map(clean)
        .filter((part, i, all) => !(part === 'Sin fecha' && all[i - 1] === 'Sin fecha'));
      if (opts.discardFolder && p.discard) folders = ['Descartadas'];
      let name = p.name;
      if (opts.rename && d) {
        const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
        if (!name.startsWith(stamp)) name = `${stamp}_${name}`;
      }
      return { photo: p, folders, name };
    });
  }

  async function sameContent(a, b) {
    if (a.size !== b.size) return false;
    const CHUNK = 4 * 1024 * 1024;
    for (let o = 0; o < a.size; o += CHUNK) {
      const [x, y] = await Promise.all([a, b].map(f => f.slice(o, o + CHUNK).arrayBuffer()));
      const u = new Uint8Array(x), v = new Uint8Array(y);
      if (u.length !== v.length) return false;
      for (let i = 0; i < u.length; i++) if (u[i] !== v[i]) return false;
    }
    return true;
  }

  async function existing(dir, name) {
    try { return await dir.getFileHandle(name); }
    catch (e) {
      if (e.name === 'NotFoundError') return null;
      throw e;
    }
  }

  async function transfer(item, root, move) {
    const p = item.photo;
    let dir = root;
    for (const f of item.folders) dir = await dir.getDirectoryHandle(f, { create: true });
    const source = await p.handle.getFile();
    const dot = item.name.lastIndexOf('.');
    const stem = item.name.slice(0, dot), ext = item.name.slice(dot);
    let name = item.name, target, status = 'copiada';

    for (let i = 2; ; i++) {
      const found = await existing(dir, name);
      if (!found) break;
      if (await found.isSameEntry(p.handle)) return { status: 'ya estaba en su lugar', name };
      if (await sameContent(source, await found.getFile())) { target = found; status = 'ya existía'; break; }
      name = `${stem} (${i})${ext}`;
    }

    if (!target) {
      target = await dir.getFileHandle(name, { create: true });
      const writable = await target.createWritable();
      try {
        await writable.write(source);
        await writable.close();
      } catch (e) {
        await writable.abort().catch(() => {});
        await dir.removeEntry(name).catch(() => {});
        throw e;
      }
    }

    if (move) {
      // Solo se quita el original si la copia es idéntica byte a byte
      if (!await sameContent(source, await target.getFile())) throw new Error('La copia no coincide; se conserva el original');
      await p.parent.removeEntry(p.name);
      p.handle = target; p.parent = dir; p.name = name;
      p.path = [root.name, ...item.folders, name].join('/');
      status = 'movida';
    }
    return { status, name };
  }

  return { plan, transfer };
})();
