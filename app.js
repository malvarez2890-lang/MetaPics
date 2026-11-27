const $ = id => document.getElementById(id);
const IMAGE_RE = /\.(jpe?g|png|webp|gif|bmp|avif|heic|heif|tiff?|dng|cr2|nef|arw)$/i;
const PAGE = 200;
const DEFAULTS = { burn: 8, dark: 55, blur: 60 };

const state = {
  photos: [], view: [], shown: PAGE, selected: new Set(), anchor: null, current: null,
  filters: { quality: new Set(), slot: new Set(), meta: new Set(), mine: new Set() },
  limits: { ...DEFAULTS, ...load('limits') },
  marks: load('marks'),
  run: 0, busy: false, dest: null, log: []
};

function load(key) {
  try { return JSON.parse(localStorage.getItem('fotos-' + key)) || {}; } catch { return {}; }
}
function save(key, value) {
  try { localStorage.setItem('fotos-' + key, JSON.stringify(value)); } catch (e) { console.warn(e); }
}
const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
};
const pad = n => String(n).padStart(2, '0');

// ---------- Carga ----------

async function* walk(dir, prefix) {
  for await (const entry of dir.values()) {
    const path = `${prefix}/${entry.name}`;
    if (entry.kind === 'directory') {
      if (!entry.name.startsWith('.') && !entry.name.startsWith('$')) yield* walk(entry, path);
    } else if (IMAGE_RE.test(entry.name) && !entry.name.startsWith('._')) {
      yield { handle: entry, parent: dir, path, name: entry.name };
    }
  }
}

async function loadDirectory(dir) {
  const entries = [];
  state.root = dir;
  $('status').textContent = 'Buscando fotos…';
  for await (const e of walk(dir, dir.name)) {
    entries.push(e);
    if (entries.length % 200 === 0) $('status').textContent = `Buscando fotos… ${entries.length}`;
  }
  await loadEntries(entries);
}

async function loadEntries(entries) {
  const run = ++state.run;
  $('grid').replaceChildren();
  state.photos.forEach(p => p.url && URL.revokeObjectURL(p.url));
  state.photos = [];
  state.selected.clear();
  state.anchor = null;
  state.shown = PAGE;
  state.busy = true;
  $('progress').hidden = $('btnStop').hidden = false;
  $('btnCsv').disabled = $('btnOrganize').disabled = true;
  let next = 0, done = 0, failed = 0, lastRender = 0;

  async function worker() {
    while (next < entries.length && run === state.run) {
      const entry = entries[next++];
      try {
        const file = entry.file || await entry.handle.getFile();
        const key = `${entry.path}|${file.size}|${file.lastModified}`;
        const data = await Analyze.photo(file, key);
        if (run !== state.run) return;
        state.photos.push(buildPhoto(entry, file, data));
      } catch (e) {
        failed++;
        console.warn('No se pudo leer', entry.path, e);
      }
      done++;
      $('progress').value = done / entries.length;
      $('status').textContent = `Analizando ${done} de ${entries.length}…`;
      if (Date.now() - lastRender > 1500) { lastRender = Date.now(); refresh(); }
    }
  }
  await Promise.all(Array.from({ length: 4 }, worker));
  const stopped = done < entries.length;
  state.busy = false;
  $('progress').hidden = $('btnStop').hidden = true;
  $('status').textContent = `${state.photos.length} fotos analizadas` +
    (failed ? ` · ${failed} no se pudieron leer` : '') + (stopped ? ' · análisis detenido' : '');
  $('btnCsv').disabled = $('btnOrganize').disabled = !state.photos.length;
  fillCameras();
  refresh();
}

function parseDate(s) {
  const m = /^(\d{4})\D(\d\d)\D(\d\d)\D(\d\d)\D(\d\d)\D(\d\d)/.exec(s || '');
  if (!m || +m[1] < 1900 || !+m[2]) return null;
  return new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}

function toDegrees(v, ref) {
  if (!Array.isArray(v) || v.length < 3) return null;
  const d = v[0] + v[1] / 60 + v[2] / 3600;
  return (ref === 'S' || ref === 'W') ? -d : d;
}

function buildPhoto(entry, file, { exif, img }) {
  const taken = parseDate(exif.dateOriginal) || parseDate(exif.dateDigitized);
  const lat = toDegrees(exif.lat, exif.latRef), lon = toDegrees(exif.lon, exif.lonRef);
  const make = exif.make || '', model = exif.model || '';
  const camera = model ? (model.toLowerCase().startsWith(make.split(' ')[0].toLowerCase()) ? model : `${make} ${model}`) : 'Cámara desconocida';
  const exposureFields = [exif.exposureTime, exif.fNumber, exif.iso].filter(Boolean).length;
  const metaLevel = taken && model && exposureFields === 3 ? 'Metadatos completos'
    : (taken || model || exposureFields) ? 'Metadatos parciales' : 'Sin metadatos';
  const markKey = `${file.name}|${file.size}`;
  const mark = state.marks[markKey] || {};
  return {
    ...entry, exif, camera, metaLevel, markKey,
    size: file.size, file: entry.file,
    // Sin fecha EXIF se usa la del archivo, y queda señalado como "estimada"
    date: taken || new Date(file.lastModified),
    estimated: !taken,
    gps: lat !== null && lon !== null && (lat || lon) ? [lat, lon] : null,
    burn: img?.burn, black: img?.black, light: img?.light, sharp: img?.sharp,
    width: img?.width || exif.width, height: img?.height || exif.height,
    url: img?.thumb ? URL.createObjectURL(img.thumb) : null,
    stars: mark.stars || 0, discard: !!mark.discard
  };
}

// ---------- Clasificación ----------

function slotOf(p) {
  if (p.estimated) return 'Hora desconocida';
  const h = p.date.getHours();
  return h < 6 ? 'Madrugada' : h < 12 ? 'Mañana' : h < 20 ? 'Tarde' : 'Noche';
}

function classify(p) {
  p.slot = slotOf(p);
  p.flags = [];
  if (p.light === undefined) {
    p.flags.push('Sin analizar');
    p.score = -1;
  } else {
    const L = state.limits;
    if (p.burn > L.burn) p.flags.push('Quemada');
    if (p.light < L.dark) p.flags.push('Oscura');
    if (p.sharp < L.blur) p.flags.push('Borrosa');
    if (!p.flags.length) p.flags.push('Buena');
    const sharp = Math.min(1, p.sharp / (L.blur * 4));
    const exposure = Math.max(0, 1 - Math.abs(p.light - 120) / 120);
    const clipping = Math.max(0, 1 - (p.burn + p.black) / 50);
    p.score = Math.round(100 * (0.45 * sharp + 0.3 * exposure + 0.25 * clipping));
  }
  p.quality = p.flags[0];
}

const FILTERS = {
  quality: { box: 'fQuality', values: ['Buena', 'Quemada', 'Oscura', 'Borrosa', 'Sin analizar'], test: (p, v) => p.flags.includes(v) },
  slot: { box: 'fSlot', values: ['Madrugada', 'Mañana', 'Tarde', 'Noche', 'Hora desconocida'], test: (p, v) => p.slot === v },
  meta: {
    box: 'fMeta', values: ['Metadatos completos', 'Metadatos parciales', 'Sin metadatos', 'Con GPS', 'Fecha estimada'],
    test: (p, v) => v === 'Con GPS' ? !!p.gps : v === 'Fecha estimada' ? p.estimated : p.metaLevel === v
  },
  mine: {
    box: 'fMine', values: ['★1+', '★3+', '★5', 'Sin estrellas', 'Descartadas', 'No descartadas'],
    test: (p, v) => ({ '★1+': p.stars >= 1, '★3+': p.stars >= 3, '★5': p.stars === 5, 'Sin estrellas': !p.stars, 'Descartadas': p.discard, 'No descartadas': !p.discard })[v]
  }
};

const SORTS = {
  date: p => p.date.getTime(),
  hour: p => p.estimated ? null : p.date.getHours() * 3600 + p.date.getMinutes() * 60 + p.date.getSeconds(),
  score: p => p.score < 0 ? null : p.score,
  sharp: p => p.sharp, burn: p => p.burn, light: p => p.light,
  stars: p => p.stars, camera: p => p.camera, iso: p => [].concat(p.exif.iso)[0],
  size: p => p.size, name: p => p.name
};

function matches(p, skipHour) {
  for (const [group, def] of Object.entries(FILTERS)) {
    const active = state.filters[group];
    if (active.size && ![...active].some(v => def.test(p, v))) return false;
  }
  const camera = $('fCamera').value;
  if (camera && p.camera !== camera) return false;
  const day = `${p.date.getFullYear()}-${pad(p.date.getMonth() + 1)}-${pad(p.date.getDate())}`;
  if ($('dFrom').value && day < $('dFrom').value) return false;
  if ($('dTo').value && day > $('dTo').value) return false;
  const from = +$('hFrom').value, to = +$('hTo').value;
  if (!skipHour && (from !== 0 || to !== 23)) {
    if (p.estimated) return false;
    const h = p.date.getHours();
    // Permite rangos que cruzan la medianoche (22 a 4)
    if (from <= to ? (h < from || h > to) : (h < from && h > to)) return false;
  }
  return true;
}

function refresh() {
  state.photos.forEach(classify);
  const key = SORTS[$('sort').value], dir = $('desc').checked ? -1 : 1;
  state.view = state.photos.filter(p => matches(p)).sort((a, b) => {
    const x = key(a), y = key(b);
    if (x === undefined || x === null) return y === undefined || y === null ? 0 : 1;
    if (y === undefined || y === null) return -1;
    return dir * (typeof x === 'string' ? x.localeCompare(y, 'es', { numeric: true }) : x - y);
  });
  renderFilters();
  renderHours();
  renderGrid();
}

function renderFilters() {
  for (const [group, def] of Object.entries(FILTERS)) {
    $(def.box).replaceChildren(...def.values.map(v => {
      const n = state.photos.filter(p => def.test(p, v)).length;
      return el('button', {
        textContent: `${v} (${n})`,
        className: state.filters[group].has(v) ? 'on' : '',
        onclick: () => {
          const set = state.filters[group];
          set.has(v) ? set.delete(v) : set.add(v);
          state.shown = PAGE;
          refresh();
        }
      });
    }));
  }
}

function renderHours() {
  const counts = Array(24).fill(0);
  state.photos.forEach(p => { if (!p.estimated && matches(p, true)) counts[p.date.getHours()]++; });
  const max = Math.max(1, ...counts);
  $('hourChart').replaceChildren(...counts.map((n, h) => {
    const bar = el('i');
    bar.style.height = `${100 * n / max}%`;
    return el('div', {
      title: `${h} h: ${n} fotos`,
      onclick: () => { $('hFrom').value = $('hTo').value = h; refresh(); }
    }, bar);
  }));
}

function fillCameras() {
  const current = $('fCamera').value;
  const cameras = [...new Set(state.photos.map(p => p.camera))].sort();
  $('fCamera').replaceChildren(new Option('Todas', ''), ...cameras.map(c => new Option(c, c)));
  $('fCamera').value = cameras.includes(current) ? current : '';
}

// ---------- Grilla ----------

function formatDate(p) {
  return p.date.toLocaleString('es', { dateStyle: 'short', timeStyle: 'short' }) + (p.estimated ? ' (estimada)' : '');
}

function card(p) {
  const thumb = el('div', { className: 'thumb' }, p.url ? el('img', { src: p.url, loading: 'lazy', alt: p.name }) : 'Sin vista previa');
  const tags = p.flags.map(f => el('span', { className: `tag ${f.toLowerCase()}`, textContent: f }));
  if (p.stars) tags.push(el('span', { className: 'tag', textContent: '★'.repeat(p.stars) }));
  if (p.discard) tags.push(el('span', { className: 'tag', textContent: 'Descartada' }));
  const node = el('div', { className: `card${state.selected.has(p) ? ' sel' : ''}${p.discard ? ' discard' : ''}`, title: p.path },
    thumb,
    el('div', { className: 'meta' },
      el('div', { className: 'name', textContent: p.name }),
      el('div', { className: 'sub', textContent: formatDate(p) }),
      ...tags));
  node.onclick = e => select(p, e.shiftKey);
  node.ondblclick = () => openViewer(p);
  p.node = node;
  return node;
}

function renderGrid() {
  $('grid').replaceChildren(...state.view.slice(0, state.shown).map(card));
  $('btnMore').hidden = state.view.length <= state.shown;
  updateCount();
}

function updateCount() {
  $('count').textContent = `${state.view.length} de ${state.photos.length} fotos · ${state.selected.size} seleccionadas`;
}

function select(p, range) {
  if (range && state.anchor && state.view.includes(state.anchor)) {
    const [a, b] = [state.view.indexOf(state.anchor), state.view.indexOf(p)].sort((x, y) => x - y);
    state.view.slice(a, b + 1).forEach(q => state.selected.add(q));
  } else {
    state.selected.has(p) ? state.selected.delete(p) : state.selected.add(p);
    state.anchor = p;
  }
  state.view.slice(0, state.shown).forEach(q => q.node?.classList.toggle('sel', state.selected.has(q)));
  updateCount();
}

function mark(photos, change) {
  photos.forEach(p => {
    Object.assign(p, change(p));
    if (p.stars || p.discard) state.marks[p.markKey] = { stars: p.stars, discard: p.discard };
    else delete state.marks[p.markKey];
  });
  save('marks', state.marks);
  refresh();
}

// ---------- Visor ----------

async function openViewer(p) {
  state.current = p;
  if (!$('viewer').open) $('viewer').showModal();
  renderInfo();
  const file = p.file || await p.handle.getFile();
  if (state.current !== p) return;
  if ($('vImg').src) URL.revokeObjectURL($('vImg').src);
  $('vImg').hidden = !p.url;
  $('vNoImg').hidden = !!p.url;
  if (p.url) $('vImg').src = URL.createObjectURL(file);
  else $('vImg').removeAttribute('src');
}

function renderInfo() {
  const p = state.current, e = p.exif;
  const first = v => [].concat(v)[0];
  const shutter = e.exposureTime ? (e.exposureTime < 1 ? `1/${Math.round(1 / e.exposureTime)} s` : `${e.exposureTime} s`) : null;
  const rows = [
    ['Fecha', formatDate(p)], ['Momento', p.slot], ['Ruta', p.path], ['Cámara', p.camera], ['Lente', e.lens],
    ['ISO', first(e.iso)], ['Apertura', e.fNumber && `f/${+e.fNumber.toFixed(1)}`], ['Obturación', shutter],
    ['Focal', e.focalLength && `${+e.focalLength.toFixed(1)} mm`],
    ['Flash', e.flash === undefined ? null : (e.flash & 1 ? 'Disparado' : 'No')],
    ['Dimensiones', p.width && `${p.width} × ${p.height}`], ['Tamaño', `${(p.size / 1048576).toFixed(2)} MB`],
    ['GPS', p.gps && p.gps.map(n => n.toFixed(5)).join(', ')], ['Software', e.software],
    ['Metadatos', p.metaLevel], ['Calidad', p.flags.join(', ')],
    ['Puntaje', p.score >= 0 ? `${p.score}/100` : null],
    ['% quemado', p.burn?.toFixed(1)], ['Brillo medio', p.light?.toFixed(0)], ['Nitidez', p.sharp?.toFixed(0)]
  ];
  $('vName').textContent = p.name;
  $('vTable').replaceChildren(...rows.filter(r => r[1] !== null && r[1] !== undefined && r[1] !== '' && r[1] !== 0 || r[0] === '% quemado' && p.burn === 0)
    .map(([k, v]) => el('tr', {}, el('td', { textContent: k }), el('td', { textContent: v }))));
  $('vStars').replaceChildren(
    ...[1, 2, 3, 4, 5].map(n => el('button', {
      textContent: n <= p.stars ? '★' : '☆',
      onclick: () => { mark([p], () => ({ stars: p.stars === n ? 0 : n })); renderInfo(); }
    })),
    el('button', {
      textContent: p.discard ? 'Recuperar' : 'Descartar',
      onclick: () => { mark([p], () => ({ discard: !p.discard })); renderInfo(); }
    }));
}

function step(delta) {
  // Si la foto salió del filtro al calificarla, se sigue desde el principio
  const i = state.view.indexOf(state.current);
  const next = state.view[i < 0 ? 0 : i + delta];
  if (next) openViewer(next);
}

// ---------- Ordenar en carpetas ----------

function planned() {
  const lists = { selected: [...state.selected], view: state.view, all: state.photos };
  return Organize.plan(lists[$('oScope').value], {
    template: $('oTemplate').value, discardFolder: $('oDiscard').checked, rename: $('oRename').checked
  });
}

function preview() {
  const items = planned();
  const folders = new Map();
  items.forEach(i => {
    const key = i.folders.join('/') || '(raíz del destino)';
    folders.set(key, (folders.get(key) || 0) + 1);
  });
  $('oPreview').textContent = [...folders].sort((a, b) => a[0].localeCompare(b[0], 'es', { numeric: true }))
    .map(([f, n]) => `${f}  →  ${n} foto${n > 1 ? 's' : ''}`).join('\n') || 'No hay fotos para ordenar';
  $('oRun').disabled = !state.dest || !items.length || state.busy;
}

function openOrganizer() {
  const readOnly = state.photos.some(p => !p.handle);
  $('oScope').replaceChildren(
    ...(state.selected.size ? [new Option(`Seleccionadas (${state.selected.size})`, 'selected')] : []),
    new Option(`Filtradas (${state.view.length})`, 'view'),
    new Option(`Todas (${state.photos.length})`, 'all'));
  $('oTemplate').value ||= $('oPreset').value;
  $('oResult').textContent = readOnly ? 'En modo solo lectura no se pueden crear carpetas. Usá "Abrir carpeta de fotos" con Chrome o Edge.' : '';
  $('oDest').disabled = readOnly;
  $('oLog').hidden = !state.log.length;
  $('organizer').showModal();
  preview();
}

async function runOrganize() {
  const items = planned();
  const move = document.querySelector('input[name=mode]:checked').value === 'move';
  // Mover también necesita permiso de escritura sobre la carpeta de origen
  for (const handle of move ? [state.root, state.dest] : [state.dest]) {
    const permission = await handle.requestPermission?.({ mode: 'readwrite' });
    if (permission && permission !== 'granted') {
      $('oResult').textContent = `Falta permiso de escritura en "${handle.name}". No se hizo ningún cambio.`;
      return;
    }
  }
  if (move && !confirm(`Vas a MOVER ${items.length} fotos a "${state.dest.name}". Los originales se quitan de su carpeta actual. ¿Continuar?`)) return;
  state.busy = true;
  $('oRun').disabled = $('oClose').disabled = $('oDest').disabled = true;
  state.log = [['origen', 'destino', 'resultado']];
  const totals = {};
  // De a una: así dos fotos con el mismo nombre nunca se pisan
  for (const [i, item] of items.entries()) {
    const origin = item.photo.path;
    $('oResult').textContent = `Procesando ${i + 1} de ${items.length}…`;
    try {
      const r = await Organize.transfer(item, state.dest, move);
      totals[r.status] = (totals[r.status] || 0) + 1;
      state.log.push([origin, [state.dest.name, ...item.folders, r.name].join('/'), r.status]);
    } catch (e) {
      totals['con error'] = (totals['con error'] || 0) + 1;
      state.log.push([origin, '', `error: ${e.message}`]);
    }
  }
  state.busy = false;
  $('oClose').disabled = $('oDest').disabled = false;
  $('oResult').textContent = 'Listo: ' + Object.entries(totals).map(([k, n]) => `${n} ${k}`).join(', ');
  $('oLog').hidden = false;
  refresh();
  preview();
}

// ---------- Exportar ----------

function downloadCsv(name, rows) {
  // Se neutralizan celdas que Excel interpretaría como fórmulas
  const cell = v => {
    let s = String(v ?? '');
    if (typeof v === 'string' && /^[=+\-@]/.test(s)) s = "'" + s;
    return `"${s.replace(/"/g, '""')}"`;
  };
  const blob = new Blob(['﻿' + rows.map(r => r.map(cell).join(';')).join('\r\n')], { type: 'text/csv' });
  const a = el('a', { href: URL.createObjectURL(blob), download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------- Eventos ----------

$('btnOpen').onclick = async () => {
  if (!window.showDirectoryPicker) {
    alert('Este navegador no permite acceder a carpetas. Usá Chrome o Edge, o el "Modo solo lectura".');
    return;
  }
  if (state.busy) return;
  try { await loadDirectory(await showDirectoryPicker({ mode: 'read' })); }
  catch (e) {
    if (e.name !== 'AbortError') $('status').textContent = 'No se pudo abrir la carpeta: ' + e.message;
  }
};
$('fallback').onchange = e => {
  if (state.busy) return;
  loadEntries([...e.target.files].filter(f => IMAGE_RE.test(f.name))
    .map(file => ({ file, name: file.name, path: file.webkitRelativePath || file.name })));
};
$('btnStop').onclick = () => {
  // Los trabajadores dejan de tomar fotos nuevas
  state.run++;
};

for (const id of ['sort', 'desc', 'hFrom', 'hTo', 'dFrom', 'dTo', 'fCamera']) {
  $(id).onchange = () => { state.shown = PAGE; refresh(); };
}

for (const [key, input, label] of [['burn', 'tBurn', 'vBurn'], ['dark', 'tDark', 'vDark'], ['blur', 'tBlur', 'vBlur']]) {
  $(input).value = state.limits[key];
  $(label).textContent = state.limits[key];
  $(input).oninput = () => {
    state.limits[key] = +$(input).value;
    $(label).textContent = $(input).value;
    save('limits', state.limits);
    refresh();
  };
}

$('btnClear').onclick = () => {
  Object.values(state.filters).forEach(s => s.clear());
  $('hFrom').value = 0; $('hTo').value = 23;
  $('dFrom').value = $('dTo').value = $('fCamera').value = '';
  refresh();
};
$('btnMore').onclick = () => { state.shown += PAGE; renderGrid(); };
$('btnSelAll').onclick = () => { state.view.forEach(p => state.selected.add(p)); renderGrid(); };
$('btnSelNone').onclick = () => { state.selected.clear(); renderGrid(); };

$('btnCsv').onclick = () => downloadCsv('fotos.csv', [
  ['ruta', 'fecha', 'fecha estimada', 'momento', 'camara', 'iso', 'apertura', 'obturacion', 'calidad', 'puntaje', '% quemado', 'brillo', 'nitidez', 'metadatos', 'latitud', 'longitud', 'estrellas', 'descartada'],
  ...state.view.map(p => [p.path,
    `${p.date.getFullYear()}-${pad(p.date.getMonth() + 1)}-${pad(p.date.getDate())} ${pad(p.date.getHours())}:${pad(p.date.getMinutes())}`,
    p.estimated ? 'si' : 'no', p.slot, p.camera, [].concat(p.exif.iso)[0], p.exif.fNumber, p.exif.exposureTime,
    p.flags.join(', '), p.score < 0 ? '' : p.score, p.burn?.toFixed(1), p.light?.toFixed(0), p.sharp?.toFixed(0), p.metaLevel,
    p.gps?.[0], p.gps?.[1], p.stars, p.discard ? 'si' : 'no'])
]);

$('vClose').onclick = () => $('viewer').close();
$('vPrev').onclick = () => step(-1);
$('vNext').onclick = () => step(1);

$('btnOrganize').onclick = openOrganizer;
$('oPreset').onchange = () => { $('oTemplate').value = $('oPreset').value; preview(); };
for (const id of ['oTemplate', 'oScope', 'oDiscard', 'oRename']) $(id).oninput = preview;
$('oDest').onclick = async () => {
  try {
    state.dest = await showDirectoryPicker({ mode: 'readwrite' });
    $('oDestName').textContent = state.dest.name;
    preview();
  } catch (e) {
    if (e.name !== 'AbortError') $('oResult').textContent = e.message;
  }
};
$('oRun').onclick = runOrganize;
$('oClose').onclick = () => $('organizer').close();
$('organizer').oncancel = e => { if (state.busy) e.preventDefault(); };
$('oLog').onclick = () => downloadCsv('registro-ordenado.csv', state.log);

document.addEventListener('keydown', e => {
  if ($('organizer').open || e.ctrlKey || e.metaKey || e.altKey) return;
  if (/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
  const viewing = $('viewer').open;
  if (viewing && e.key === 'ArrowLeft') return step(-1);
  if (viewing && e.key === 'ArrowRight') return step(1);
  const targets = viewing ? [state.current] : [...state.selected];
  if (!targets.length) return;
  if (/^[0-5]$/.test(e.key)) mark(targets, () => ({ stars: +e.key }));
  else if (e.key.toLowerCase() === 'x') {
    const discard = !targets.every(p => p.discard);
    mark(targets, () => ({ discard }));
  } else return;
  if (viewing) renderInfo();
});

window.addEventListener('beforeunload', e => { if (state.busy) e.preventDefault(); });

refresh();
