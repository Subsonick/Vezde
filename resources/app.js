'use strict';
/* Vezde — desktop travel diary (Neutralino + Leaflet).
   Data is saved automatically to <app folder>/data/travel-data.json (or localStorage when opened in a plain browser). */

// ======================================================================
// Utilities
// ======================================================================
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fmtDate = d => { if (!d) return ''; const [y, m, day] = d.split('-'); return `${day}.${m}.${y}`; };
const fmtKm = km => `${Math.round(km).toLocaleString('ru-RU')} км`;
const plural = (n, a, b, c) => { const m10 = n % 10, m100 = n % 100; return m10 === 1 && m100 !== 11 ? a : (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20) ? b : c); };
const todayISO = () => new Date().toISOString().slice(0, 10);
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

function haversine(a, b) {
  const R = 6371, r = d => d * Math.PI / 180;
  const dLat = r(b[0] - a[0]), dLon = r(b[1] - a[1]);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(r(a[0])) * Math.cos(r(b[0])) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}
function bearing(a, b) {
  const r = d => d * Math.PI / 180;
  const y = Math.sin(r(b[1] - a[1])) * Math.cos(r(b[0]));
  const x = Math.cos(r(a[0])) * Math.sin(r(b[0])) - Math.sin(r(a[0])) * Math.cos(r(b[0])) * Math.cos(r(b[1] - a[1]));
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}
/** Accepts "55.932118, 40.898444", "55.93 40.89", "55,932118 40,898444", "(55.93; 40.89)". */
function parseCoords(str) {
  if (!str) return null;
  let s = String(str).trim().replace(/[()\[\]]/g, '');
  let parts;
  if (/^-?\d+,\d+\s+-?\d+,\d+$/.test(s)) parts = s.split(/\s+/).map(x => x.replace(',', '.'));
  else parts = s.split(/[,;\s]+/).filter(Boolean);
  if (parts.length !== 2) return null;
  let [a, b] = parts.map(Number);
  if (!isFinite(a) || !isFinite(b)) return null;
  if (Math.abs(a) > 90 && Math.abs(b) <= 90) [a, b] = [b, a];
  if (Math.abs(a) > 90 || Math.abs(b) > 180) return null;
  return { lat: a, lon: b };
}
const coordsText = (lat, lon) => `${(+lat).toFixed(6)}, ${(+lon).toFixed(6)}`;

// ======================================================================
// Constants
// ======================================================================
const REGIONS = window.RU_REGIONS || [];
// bright route colours that read on both the dark and the light map
const TRIP_COLORS = ['#3fb4ff', '#ff6b6b', '#45d49b', '#b48cff', '#ffc24a', '#ff7ec4', '#4fe0d8', '#c4e05c', '#ff9452', '#7d9bff', '#e3bf86', '#9fb0c2'];
// colours of the old (paper) palette -> new palette, so existing trips get the new look
const LEGACY_COLORS = { '#b5793a': '#ffc24a', '#3f6b5e': '#45d49b', '#a5443a': '#ff6b6b', '#4a6fa5': '#3fb4ff', '#7a5c9e': '#b48cff', '#c4932f': '#ff9452',
  '#2f8f83': '#4fe0d8', '#9e4a6f': '#ff7ec4', '#5f7a35': '#c4e05c', '#3a5c9e': '#7d9bff', '#c0603a': '#e3bf86', '#6b6b2f': '#9fb0c2' };
const modernColor = c => LEGACY_COLORS[String(c || '').toLowerCase()] || c;
const NO_TRIP = '';
const NO_TRIP_COLOR = '#8d99a8';
const DEFAULT_SETTINGS = {
  tab: 'add', selectedTrips: null, year: 'all',
  baseLayer: 'auto', showRegions: true, showRoutes: false,
  view: null, theme: 'light',
};

// ======================================================================
// Storage (native file storage via Neutralino, localStorage fallback)
// ======================================================================
const IS_NATIVE = typeof window.NL_PORT !== 'undefined' && typeof Neutralino !== 'undefined';

const Store = {
  dir: null, file: null, cacheFile: null, backupDir: null,

  migrated: null,   // {files} when data was moved from the old place next to the exe
  async init() {
    if (!IS_NATIVE) return;
    Neutralino.init();
    const appRoot = (window.NL_PATH || '.').replace(/\\/g, '/').replace(/\/$/, '');
    this.legacyDir = appRoot + '/data';
    // Data lives in %APPDATA%\Vezde, so the program file can be moved or replaced freely.
    // A file "portable.txt" next to the exe keeps the data next to it instead (for USB sticks).
    let base = '';
    const portable = await this.exists(appRoot + '/portable.txt');
    if (!portable) { try { base = (await Neutralino.os.getPath('data')).replace(/\\/g, '/').replace(/\/$/, ''); } catch {} }
    this.dir = base ? base + '/Vezde' : this.legacyDir;
    this.file = this.dir + '/travel-data.json';
    this.cacheFile = this.dir + '/route-cache.json';
    this.backupDir = this.dir + '/backups';
    await this.ensureDir(this.dir);
    await this.ensureDir(this.backupDir);
    if (this.dir !== this.legacyDir) await this.migrateLegacy();
  },
  async exists(p) { try { await Neutralino.filesystem.getStats(p); return true; } catch { return false; } },
  /** Moves data from the old folder next to the exe (versions up to 2.1) to the new place. Copies, verifies, only then deletes the old folder. */
  async migrateLegacy() {
    const from = this.legacyDir;
    if (!(await this.exists(from + '/travel-data.json'))) return;
    if (await this.exists(this.file)) return;          // already moved earlier: never overwrite newer data
    const copied = [];
    const walk = async (src, dst) => {
      await this.ensureDir(dst);
      for (const e of await Neutralino.filesystem.readDirectory(src)) {
        if (e.entry === '.' || e.entry === '..') continue;
        const s = `${src}/${e.entry}`, d = `${dst}/${e.entry}`;
        if (e.type === 'DIRECTORY') await walk(s, d);
        else { await Neutralino.filesystem.writeBinaryFile(d, await Neutralino.filesystem.readBinaryFile(s)); copied.push([s, d]); }
      }
    };
    try {
      await walk(from, this.dir);
      for (const [s, d] of copied) {
        if ((await Neutralino.filesystem.getStats(s)).size !== (await Neutralino.filesystem.getStats(d)).size) throw new Error('size mismatch: ' + d);
      }
      JSON.parse(await Neutralino.filesystem.readFile(this.file));
    } catch (e) {
      console.error('migration failed', e);
      try { await Neutralino.filesystem.remove(this.file); } catch {}   // fall back to the old place next time
      this.dir = from; this.file = from + '/travel-data.json'; this.cacheFile = from + '/route-cache.json'; this.backupDir = from + '/backups';
      return;
    }
    try { await Neutralino.filesystem.remove(from); } catch {}
    this.migrated = { files: copied.length };
  },
  async ensureDir(p) {
    try { await Neutralino.filesystem.getStats(p); }
    catch { await Neutralino.filesystem.createDirectory(p); }
  },
  async readJSON(path, lsKey) {
    try {
      if (IS_NATIVE) return JSON.parse(await Neutralino.filesystem.readFile(path));
      const raw = localStorage.getItem(lsKey);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  },
  async writeJSON(path, lsKey, obj) {
    const text = JSON.stringify(obj, null, 1);
    if (!IS_NATIVE) { localStorage.setItem(lsKey, text); return; }
    const tmp = path + '.tmp';
    await Neutralino.filesystem.writeFile(tmp, text);
    try { await Neutralino.filesystem.move(tmp, path); }
    catch { await Neutralino.filesystem.writeFile(path, text); try { await Neutralino.filesystem.remove(tmp); } catch {} }
  },
  /** Returns parsed data, null if there is no file yet. A file that exists but can't be parsed is set aside, never overwritten. */
  async loadData() {
    if (!IS_NATIVE) return this.readJSON(this.file, 'travelmap.data');
    let text;
    try { text = await Neutralino.filesystem.readFile(this.file); } catch { return null; }
    try { return JSON.parse(text); }
    catch {
      const broken = this.file.replace(/\.json$/, `.broken-${Date.now()}.json`);
      try { await Neutralino.filesystem.move(this.file, broken); } catch {}
      setTimeout(() => toast('Файл данных повреждён', 'Он сохранён рядом как travel-data.broken-….json. Можно загрузить последнюю копию из data\\backups.'), 800);
      return null;
    }
  },
  saveData(d) { return this.writeJSON(this.file, 'travelmap.data', d); },
  loadCache() { return this.readJSON(this.cacheFile, 'travelmap.cache'); },
  saveCache(c) { return this.writeJSON(this.cacheFile, 'travelmap.cache', c); },

  /** One automatic snapshot per day, keeps the last 20. */
  async dailyBackup(d, force = false) {
    if (!IS_NATIVE || readOnly || !d.points.length) return;
    const name = force ? `${typeof force === 'string' ? force : 'before-import'}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json` : `travel-${todayISO()}.json`;
    const path = `${this.backupDir}/${name}`;
    if (!force) { try { await Neutralino.filesystem.getStats(path); return; } catch {} }
    try {
      await Neutralino.filesystem.writeFile(path, JSON.stringify(d, null, 1));
      const entries = (await Neutralino.filesystem.readDirectory(this.backupDir))
        .filter(e => e.type === 'FILE' && /^travel-\d{4}-\d\d-\d\d\.json$/.test(e.entry))
        .map(e => e.entry).sort();
      for (const old of entries.slice(0, Math.max(0, entries.length - 20))) {
        try { await Neutralino.filesystem.remove(`${this.backupDir}/${old}`); } catch {}
      }
    } catch (e) { console.warn('backup failed', e); }
  },

  async exportFile(obj, suggestedName) {
    const text = JSON.stringify(obj, null, 2);
    if (IS_NATIVE) {
      const docs = await Neutralino.os.getPath('documents').catch(() => '');
      const target = await Neutralino.os.showSaveDialog('Сохранить бэкап', {
        defaultPath: docs ? `${docs}/${suggestedName}` : suggestedName,
        filters: [{ name: 'Бэкап (JSON)', extensions: ['json'] }],
      });
      if (!target) return null;
      const path = /\.json$/i.test(target) ? target : target + '.json';
      await Neutralino.filesystem.writeFile(path, text);
      return path;
    }
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: suggestedName });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return suggestedName;
  },
  async importFile() {
    if (IS_NATIVE) {
      const files = await Neutralino.os.showOpenDialog('Загрузить бэкап', {
        filters: [{ name: 'Бэкап (JSON)', extensions: ['json'] }],
      });
      if (!files || !files.length) return null;
      return Neutralino.filesystem.readFile(files[0]);
    }
    return new Promise(resolve => {
      const inp = $('importInput');
      inp.value = '';
      inp.onchange = async () => resolve(inp.files[0] ? await inp.files[0].text() : null);
      inp.click();
    });
  },
  async openFolder() {
    if (!IS_NATIVE) return;
    const winPath = this.dir.replace(/\//g, '\\');
    try { await Neutralino.os.execCommand(`explorer "${winPath}"`, { background: true }); }
    catch { await Neutralino.os.open('file:///' + this.dir); }
  },
};

// ======================================================================
// State
// ======================================================================
/** Format of travel-data.json. Raise it whenever the stored shape changes; older formats are upgraded on load. */
const DATA_FORMAT = 3;
const APP_VERSION = window.NL_APPVERSION || '1.1.1';
let readOnly = false;          // data came from a newer Vezde: show it, never write it
let data = { version: DATA_FORMAT, points: [], trips: [], settings: { ...DEFAULT_SETTINGS } };
let routeCache = {};           // key -> {path:[[lat,lon]...], km}
let editingId = null;

/** Normalises any supported shape (v1 backups from the old HTML version, v2) into v2. */
function normalizeData(raw) {
  const out = { version: DATA_FORMAT, points: [], trips: [], settings: { ...DEFAULT_SETTINGS } };
  if (!raw || typeof raw !== 'object') return out;
  const usedColors = new Set();
  (Array.isArray(raw.trips) ? raw.trips : []).forEach((t, i) => {
    if (!t || t.id == null || !String(t.name || '').trim()) return;
    const color = modernColor(t.color) || TRIP_COLORS[i % TRIP_COLORS.length];
    usedColors.add(color);
    out.trips.push({ ...t, id: String(t.id), name: String(t.name).trim(), color, comment: String(t.comment || ''), photos: Array.isArray(t.photos) ? t.photos.map(String) : [] });
  });
  const tripIds = new Set(out.trips.map(t => t.id));
  (Array.isArray(raw.points) ? raw.points : []).forEach(p => {
    if (!p) return;
    const lat = Number(p.lat), lon = Number(p.lon);
    if (!isFinite(lat) || !isFinite(lon) || !String(p.name || '').trim()) return;
    const tripId = p.tripId != null && tripIds.has(String(p.tripId)) ? String(p.tripId) : NO_TRIP;
    out.points.push({
      ...p, id: String(p.id ?? uid()), name: String(p.name).trim(), address: String(p.address || ''),
      lat, lon, date: /^\d{4}-\d\d-\d\d$/.test(p.date || '') ? p.date : '',
      note: String(p.note || ''), region: normalizeRegion(p.region) || '', tripId,
      photos: Array.isArray(p.photos) ? p.photos.map(String) : [],
      createdAt: p.createdAt || Date.now(), updatedAt: p.updatedAt || Date.now(),
    });
  });
  if (raw.settings && typeof raw.settings === 'object') {
    Object.assign(out.settings, raw.settings);
    // first start after the redesign: switch to the map that matches the theme
    if (!raw.settings.theme) out.settings.theme = 'dark';
  }
  return out;
}

const saveState = $('saveState');
function setSaveState(kind) {
  saveState.className = 'save-state' + (kind === 'ok' ? '' : ' ' + kind);
  saveState.textContent = kind === 'pending' ? 'сохраняю…' : kind === 'error' ? 'не сохранено' : kind === 'readonly' ? 'только просмотр' : 'сохранено';
  saveState.title = kind === 'readonly' ? 'Данные сохранены более новой версией Vezde. Изменения не сохраняются, обновите программу.' : 'Все изменения сохраняются автоматически';
}
let saveTimer = null, savePromise = Promise.resolve();
function persist() {
  if (readOnly) { setSaveState('readonly'); return; }
  setSaveState('pending');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 350);
}
function flushSave() {
  clearTimeout(saveTimer); saveTimer = null;
  savePromise = savePromise.then(async () => {
    try { await Store.saveData(data); setSaveState('ok'); }
    catch (e) { console.error(e); setSaveState('error'); toast('Не удалось сохранить данные', String(e.message || e), 'err'); }
  });
  return savePromise;
}
const persistCache = debounce(() => Store.saveCache(routeCache).catch(() => {}), 800);
const S = () => data.settings;
function setSetting(k, v) { S()[k] = v; persist(); }

// ======================================================================
// Regions
// ======================================================================
const REGION_ALIASES = {
  'москва': 'Москва', 'санкт-петербург': 'Санкт-Петербург', 'севастополь': 'Севастополь',
  'адыгея': 'Республика Адыгея', 'алтай': 'Республика Алтай', 'башкортостан': 'Республика Башкортостан',
  'бурятия': 'Республика Бурятия', 'дагестан': 'Республика Дагестан', 'ингушетия': 'Республика Ингушетия',
  'калмыкия': 'Республика Калмыкия', 'карелия': 'Республика Карелия', 'коми': 'Республика Коми',
  'марий эл': 'Республика Марий Эл', 'мордовия': 'Республика Мордовия', 'якутия': 'Республика Саха (Якутия)',
  'саха': 'Республика Саха (Якутия)', 'северная осетия': 'Республика Северная Осетия — Алания',
  'татарстан': 'Республика Татарстан', 'тыва': 'Республика Тыва', 'тува': 'Республика Тыва',
  'хакасия': 'Республика Хакасия', 'чечня': 'Чеченская Республика', 'чувашия': 'Чувашская Республика',
  'удмуртия': 'Удмуртская Республика', 'кабардино-балкария': 'Кабардино-Балкарская Республика',
  'карачаево-черкесия': 'Карачаево-Черкесская Республика', 'крым': 'Республика Крым',
  'югра': 'Ханты-Мансийский автономный округ — Югра', 'кузбасс': 'Кемеровская область',
};
function normalizeRegion(raw) {
  if (!raw) return '';
  const s = String(raw).trim().toLowerCase().replace(/ё/g, 'е').replace(/\s+-\s+/g, ' — ').replace(/\s+/g, ' ');
  if (!s) return '';
  for (const R of REGIONS) { const r = R.toLowerCase().replace(/ё/g, 'е'); if (r === s) return R; }
  for (const R of REGIONS) {
    const r = R.toLowerCase().replace(/ё/g, 'е');
    const core = r.replace(/^республика /, '').replace(/ (республика|область|край|автономный округ|автономная область)$/, '').split(' — ')[0].split(' (')[0];
    if (core.length > 3 && s.includes(core)) return R;
  }
  for (const [k, v] of Object.entries(REGION_ALIASES)) if (s.includes(k)) return v;
  return '';
}

const regionIndex = (window.RU_REGION_SHAPES?.features || []).map(f => {
  const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
  let minX = 180, minY = 90, maxX = -180, maxY = -90;
  polys.forEach(p => p[0].forEach(([x, y]) => { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }));
  return { name: f.properties.name, polys, bbox: [minX, minY, maxX, maxY] };
});
function inRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function detectRegionOffline(lat, lon) {
  for (const r of regionIndex) {
    const [a, b, c, d] = r.bbox;
    if (lon < a || lon > c || lat < b || lat > d) continue;
    for (const poly of r.polys) {
      if (inRing(lon, lat, poly[0]) && !poly.slice(1).some(h => inRing(lon, lat, h))) return r.name;
    }
  }
  return '';
}

// ======================================================================
// Geocoding (Photon for autocomplete & reverse, Nominatim as fallback)
// ======================================================================
function photonLabel(p) {
  const pr = p.properties || {};
  const street = [pr.street, pr.housenumber].filter(Boolean).join(', ');
  const name = pr.name || street || pr.city || pr.state || 'Без названия';
  const parts = [];
  if (pr.name && street) parts.push(street);
  [pr.city || pr.town || pr.village, pr.district && pr.district !== pr.city ? pr.district : null, pr.county, pr.state, pr.country]
    .forEach(x => { if (x && !parts.includes(x) && x !== name) parts.push(x); });
  return { name, address: parts.join(', '), region: pr.countrycode === 'RU' || pr.country === 'Россия' ? pr.state : '' };
}
async function searchPlaces(q, signal) {
  try {
    const r = await fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=7&lang=default`, { signal });
    if (!r.ok) throw new Error('photon ' + r.status);
    const j = await r.json();
    return (j.features || []).map(f => ({ ...photonLabel(f), lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0] }));
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    const r = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&accept-language=ru&limit=7&q=${encodeURIComponent(q)}`, { signal });
    const j = await r.json();
    return j.map(d => ({ name: d.name || d.display_name.split(',')[0], address: d.display_name, region: d.address?.state || '', lat: +d.lat, lon: +d.lon }));
  }
}
async function reverseGeocode(lat, lon) {
  try {
    const r = await fetch(`https://photon.komoot.io/reverse?lat=${lat}&lon=${lon}&lang=default`);
    const j = await r.json();
    if (j.features && j.features[0]) return photonLabel(j.features[0]);
  } catch {}
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&addressdetails=1&accept-language=ru&lat=${lat}&lon=${lon}`);
    const d = await r.json();
    if (d && d.display_name) return { name: d.name || d.display_name.split(',')[0], address: d.display_name, region: d.address?.state || '' };
  } catch {}
  return null;
}
async function regionFor(lat, lon, hint) {
  return detectRegionOffline(lat, lon) || normalizeRegion(hint) || normalizeRegion((await reverseGeocode(lat, lon))?.region);
}

// ======================================================================
// UI primitives: toast & modal
// ======================================================================
function toast(title, msg, kind = 'err') {
  const key = title + '|' + (msg || '');
  let t = [...$('toasts').children].find(x => x.dataset.key === key && !x.classList.contains('gone'));
  if (t) {
    // same message already on screen: just restart it instead of stacking a copy
    clearTimeout(t._timer);
    t.classList.remove('bump'); void t.offsetWidth; t.classList.add('bump');
  } else {
    t = document.createElement('div');
    t.className = 'toast ' + (kind === 'ok' ? 'ok' : kind === 'info' ? 'info' : '');
    t.dataset.key = key;
    t.innerHTML = `<span class="t-ic">${icon(kind === 'ok' ? 'check' : kind === 'info' ? 'info' : 'alert', 15)}</span><div><b>${esc(title)}</b>${msg ? esc(msg) : ''}</div>`;
    $('toasts').appendChild(t);
    requestAnimationFrame(() => t.classList.add('show'));
  }
  t._timer = setTimeout(() => { t.classList.add('gone'); t.classList.remove('show'); setTimeout(() => t.remove(), 250); }, 4000);
}
function modal({ icon: ic = 'info', tone = '', title, text = '', buttons }) {
  return new Promise(resolve => {
    const bg = document.createElement('div');
    bg.className = 'modal-bg';
    bg.innerHTML = `<div class="modal" role="dialog" aria-modal="true">
      <div class="mi ${tone}">${icon(ic, 22)}</div><div class="mt">${esc(title)}</div>
      ${text ? `<div class="mx">${esc(text)}</div>` : ''}
      <div class="ma">${buttons.map((b, i) => `<button data-i="${i}" class="${b.style || ''}">${esc(b.label)}</button>`).join('')}</div></div>`;
    document.body.appendChild(bg);
    requestAnimationFrame(() => bg.classList.add('show'));
    const close = v => { document.removeEventListener('keydown', onKey); bg.classList.remove('show'); setTimeout(() => bg.remove(), 180); resolve(v); };
    const onKey = e => { if (e.key === 'Escape') close(null); };
    document.addEventListener('keydown', onKey);
    bg.addEventListener('click', e => { if (e.target === bg) close(null); });
    bg.querySelectorAll('button').forEach(b => b.addEventListener('click', () => close(buttons[b.dataset.i].value)));
    bg.querySelector('button.primary, button')?.focus();
  });
}

// ======================================================================
// Trips & filters
// ======================================================================
const tripById = id => data.trips.find(t => t.id === id);
const tripName = id => id ? (tripById(id)?.name || 'Без поездки') : 'Без поездки';
const tripColor = id => id ? (modernColor(tripById(id)?.color) || NO_TRIP_COLOR) : NO_TRIP_COLOR;
function nextTripColor() {
  const used = data.trips.map(t => t.color);
  return TRIP_COLORS.find(c => !used.includes(c)) || TRIP_COLORS[data.trips.length % TRIP_COLORS.length];
}
function allTripKeys() {
  const keys = data.trips.map(t => t.id);
  if (data.points.some(p => !p.tripId)) keys.push(NO_TRIP);
  return keys;
}
function selectedKeys() {
  const sel = S().selectedTrips;
  return sel === null ? new Set(allTripKeys()) : new Set(sel);
}
function sortedByDate(list) {
  return [...list].sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999') || a.createdAt - b.createdAt);
}
function filteredPoints() {
  const keys = selectedKeys(), y = S().year;
  return data.points.filter(p => keys.has(p.tripId) && (y === 'all' || (p.date || '').startsWith(y)));
}
function createTrip(name) {
  const t = { id: 't' + uid(), name: name.trim(), color: nextTripColor() };
  data.trips.push(t);
  if (S().selectedTrips !== null) S().selectedTrips = [...S().selectedTrips, t.id];
  persist();
  return t;
}

function renderFilters() {
  const keys = allTripKeys();
  const sel = selectedKeys();
  const count = id => data.points.filter(p => p.tripId === id).length;
  $('tripChecks').innerHTML = keys.length ? keys.map(k => `
    <label class="check-row"><input type="checkbox" data-k="${esc(k)}" ${sel.has(k) ? 'checked' : ''}>
      <span class="dot" style="background:${tripColor(k)}"></span><span class="name">${esc(tripName(k))}</span><span class="cnt">${count(k)}</span></label>`).join('')
    : '<div class="empty" style="padding:12px">Поездок пока нет</div>';
  const n = keys.filter(k => sel.has(k)).length;
  $('tripPickerBtn').textContent = !keys.length || n === keys.length ? 'Все поездки' : n === 0 ? 'Поездки не выбраны'
    : n === 1 ? tripName(keys.find(k => sel.has(k))) : `${n} ${plural(n, 'поездка', 'поездки', 'поездок')} из ${keys.length}`;

  const years = [...new Set(data.points.map(p => (p.date || '').slice(0, 4)).filter(Boolean))].sort().reverse();
  if (S().year !== 'all' && !years.includes(S().year)) S().year = 'all';
  $('yearFilter').innerHTML = '<option value="all">Все годы</option>' + years.map(y => `<option value="${y}">${y}</option>`).join('');
  $('yearFilter').value = S().year;
}
function setSelected(set) {
  const keys = allTripKeys();
  S().selectedTrips = keys.every(k => set.has(k)) ? null : [...set];
  persist();
  refreshAll(true);
}

// ======================================================================
// Map
// ======================================================================
let map, markerLayer, regionLayer, routeLayer, arrowLayer, pickMarker = null, picking = false;
const markerById = new Map();
const cssVar = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const theme = () => document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';

const BASE_OPTIONS = [
  { key: 'osm', label: 'Схема', swatch: () => 'linear-gradient(135deg,#f2efe9 0 45%,#aad3df 45% 60%,#c8e6b4 60%)' },
  { key: 'auto', label: 'Под тему', swatch: () => theme() === 'dark' ? 'linear-gradient(135deg,#242a31,#3a414a)' : 'linear-gradient(135deg,#eceeef,#d8dcdf)' },
  { key: 'topo', label: 'Рельеф', swatch: () => 'linear-gradient(135deg,#cfdcb5,#e9e0c5 55%,#c9b892)' },
  { key: 'sat', label: 'Спутник', swatch: () => 'linear-gradient(135deg,#2f4a2c,#56663e 50%,#3f5a6e)' },
  { key: 'dark', label: 'Тёмная', swatch: () => 'linear-gradient(135deg,#1f242a,#30363d)' },
  { key: 'light', label: 'Светлая', swatch: () => 'linear-gradient(135deg,#f3f4f4,#dcdfe1)' },
];
const BASES = {
  osm: () => L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap' }),
  light: () => L.layerGroup([
    esriTiles('Canvas/World_Light_Gray_Base', { maxZoom: 16 }),
    esriTiles('Canvas/World_Light_Gray_Reference', { maxZoom: 16, pane: 'labels' }),
  ]),
  dark: () => L.layerGroup([
    esriTiles('Canvas/World_Dark_Gray_Base', { maxZoom: 16 }),
    esriTiles('Canvas/World_Dark_Gray_Reference', { maxZoom: 16, pane: 'labels' }),
  ]),
  topo: () => esriTiles('World_Topo_Map', { maxZoom: 19 }),
  sat: () => L.layerGroup([
    esriTiles('World_Imagery', { maxZoom: 19 }),
    esriTiles('Reference/World_Boundaries_and_Places', { maxZoom: 19, pane: 'labels' }),
  ]),
};
function esriTiles(service, opts) {
  return L.tileLayer(`https://server.arcgisonline.com/ArcGIS/rest/services/${service}/MapServer/tile/{z}/{y}/{x}`,
    { attribution: 'Tiles &copy; Esri', maxNativeZoom: Math.min(opts.maxZoom, 18), ...opts, maxZoom: 19 });
}
let baseLayer = null, baseKey = null;

/** Space the floating sidebar covers on the left of the map. */
function sideInset() {
  const sb = document.querySelector('.sidebar');
  return sb ? sb.getBoundingClientRect().right : 0;
}
function fitPoints(latlngs, maxZoom = 10) {
  if (!latlngs.length) return;
  map.fitBounds(L.latLngBounds(latlngs), { paddingTopLeft: [sideInset() + 50, 60], paddingBottomRight: [80, 60], maxZoom });
}
/** Centres a location in the visible part of the map (right of the sidebar). */
function focusAt(latlng, zoom) {
  const z = zoom ?? map.getZoom();
  const p = map.project(latlng, z).subtract([sideInset() / 2, 0]);
  map.setView(map.unproject(p, z), z);
}

function initMap() {
  map = L.map('map', { zoomControl: false, worldCopyJump: true, preferCanvas: false });
  L.control.zoom({ position: 'topright', zoomInTitle: 'Приблизить', zoomOutTitle: 'Отдалить' }).addTo(map);
  map.attributionControl.setPrefix(false);
  map.createPane('labels');
  map.getPane('labels').style.zIndex = 380;            // above base tiles, below region fill, routes and markers
  map.getPane('labels').style.pointerEvents = 'none';
  const v = S().view;
  if (v && isFinite(v.lat)) map.setView([v.lat, v.lon], v.zoom); else map.setView([58, 75], 4);
  setBase(S().baseLayer);
  regionLayer = L.layerGroup().addTo(map);
  routeLayer = L.layerGroup().addTo(map);
  markerLayer = L.layerGroup().addTo(map);
  arrowLayer = L.layerGroup().addTo(map);
  map.on('moveend', debounce(() => {
    const c = map.getCenter();
    S().view = { lat: +c.lat.toFixed(5), lon: +c.lng.toFixed(5), zoom: map.getZoom() };
    persist();
  }, 600));
  map.on('zoomend', updateArrows);
  map.on('click', onMapClick);
  map.on('popupopen', e => {
    const el = e.popup.getElement();
    el.querySelector('[data-edit]')?.addEventListener('click', ev => { map.closePopup(); startEdit(ev.currentTarget.dataset.edit); });
    hydratePhotos(el);
    el.querySelectorAll('[data-lb]').forEach(x => x.addEventListener('click', () => {
      const p = data.points.find(q => q.id === x.dataset.lb); if (p) Lightbox.open(p.photos, +x.dataset.i, p.name);
    }));
  });
}
function setBase(key) {
  if (!BASE_OPTIONS.some(o => o.key === key)) key = 'osm';
  const real = key === 'auto' ? theme() : key;
  if (baseLayer && baseKey === real) { renderBaseList(key); return; }
  if (baseLayer) map.removeLayer(baseLayer);
  baseLayer = BASES[real]().addTo(map); baseKey = real;
  (baseLayer.eachLayer ? baseLayer.getLayers() : [baseLayer]).forEach(l => { if (!l.options.pane || l.options.pane === 'tilePane') l.bringToBack(); });
  renderBaseList(key);
}
function renderBaseList(key) {
  $('baseList').innerHTML = BASE_OPTIONS.map(o => `<button type="button" class="base-opt ${o.key === key ? 'on' : ''}" role="radio" aria-checked="${o.key === key}" data-base="${o.key}">
    <span class="sw-img" style="background:${o.swatch()}"></span>${o.label}</button>`).join('');
}

function popupHtml(p) {
  const c = tripColor(p.tripId);
  return `<div class="pp-trip"><span class="dot" style="background:${c}"></span>${esc(tripName(p.tripId))}</div>
    <div class="pp-title">${esc(p.name)}</div>
    <div class="pp-meta">${p.date ? `<span>${icon('calendar', 13)}${esc(fmtDate(p.date))}</span>` : ''}${p.region ? `<span>${icon('map', 13)}${esc(p.region)}</span>` : ''}</div>
    ${p.address ? `<div class="pp-addr">${esc(p.address)}</div>` : ''}
    ${p.note ? `<div class="pp-note">${esc(p.note)}</div>` : ''}
    ${p.photos?.length ? `<div class="pp-photos">${p.photos.slice(0, 4).map((id, i) => `<img data-photo="${esc(id)}" data-lb="${esc(p.id)}" data-i="${i}" alt="">`).join('')}${p.photos.length > 4 ? `<span class="pp-more" data-lb="${esc(p.id)}" data-i="4">+${p.photos.length - 4}</span>` : ''}</div>` : ''}
    <div class="pp-acts"><button data-edit="${esc(p.id)}">${icon('edit', 14)}Изменить</button></div>`;
}
function pointIcon(color) {
  return L.divIcon({ className: '', iconSize: [18, 18], iconAnchor: [9, 9], popupAnchor: [0, -8], tooltipAnchor: [0, -10],
    html: `<div class="vz-marker" style="--c:${color}"></div>` });
}
function renderMarkers(fit) {
  markerLayer.clearLayers(); markerById.clear();
  const fp = filteredPoints();
  fp.forEach(p => {
    const m = L.marker([p.lat, p.lon], { icon: pointIcon(tripColor(p.tripId)), riseOnHover: true, keyboard: false })
      .bindPopup(popupHtml(p), { maxWidth: 300 })
      .bindTooltip(esc(p.name), { direction: 'top' })
      .addTo(markerLayer);
    markerById.set(p.id, m);
  });
  if (fit && fp.length) fitPoints(fp.map(p => [p.lat, p.lon]));
  renderLegend(fp);
}
function renderLegend(fp) {
  const keys = [...new Set(fp.map(p => p.tripId))];
  const el = $('legend');
  if (!keys.length) { el.hidden = true; return; }
  keys.sort((a, b) => (a === NO_TRIP) - (b === NO_TRIP) || tripName(a).localeCompare(tripName(b)));
  el.innerHTML = keys.map(k => `<div class="lr"><span class="dot" style="background:${tripColor(k)}"></span>${esc(tripName(k))}</div>`).join('');
  el.hidden = false;
}

function visitedRegions(points) {
  const m = new Map();
  points.forEach(p => { if (p.region && REGIONS.includes(p.region)) m.set(p.region, (m.get(p.region) || 0) + 1); });
  return m;
}
function renderRegions() {
  regionLayer.clearLayers();
  if (!S().showRegions || !window.RU_REGION_SHAPES) return;
  const visited = visitedRegions(filteredPoints());
  const shapes = { type: 'FeatureCollection', features: window.RU_REGION_SHAPES.features.filter(f => visited.has(f.properties.name)) };
  const st = { color: cssVar('--region-line'), weight: 1.2, opacity: .75, fillColor: cssVar('--region-fill'), fillOpacity: +cssVar('--region-fill-op') || .18 };
  L.geoJSON(shapes, {
    interactive: true,
    style: () => st,
    onEachFeature: (f, layer) => {
      const n = visited.get(f.properties.name);
      layer.bindTooltip(`<b>${esc(f.properties.name)}</b><br>${n} ${plural(n, 'точка', 'точки', 'точек')}`, { sticky: true, className: 'region-tip' });
    },
  }).addTo(regionLayer);
}

// ---- routes along real roads, cached ----
const ARROW_HIDE_ZOOM = 6, ARROW_FULL_ZOOM = 10;
function arrowScale(z) { return z < ARROW_HIDE_ZOOM ? 0 : z >= ARROW_FULL_ZOOM ? 1 : .5 + .5 * (z - ARROW_HIDE_ZOOM) / (ARROW_FULL_ZOOM - ARROW_HIDE_ZOOM); }
function arrowIcon(color, angle, scale) {
  const s = Math.round(22 * scale);
  return L.divIcon({
    className: '', iconSize: [s, s], iconAnchor: [s / 2, s / 2],
    html: `<svg width="${s}" height="${s}" viewBox="0 0 24 24" style="transform:rotate(${angle}deg);display:block">
      <circle cx="12" cy="12" r="11" fill="var(--arrow-bg)" stroke="${color}" stroke-width="1.6"/>
      <path d="M12 5.5 L17.5 15.5 L12 12.8 L6.5 15.5 Z" fill="${color}"/></svg>`,
  });
}
function updateArrows() {
  const sc = arrowScale(map.getZoom());
  if (sc === 0) { if (map.hasLayer(arrowLayer)) map.removeLayer(arrowLayer); return; }
  if (!map.hasLayer(arrowLayer)) arrowLayer.addTo(map);
  arrowLayer.eachLayer(m => m.setIcon(arrowIcon(m.options.color, m.options.angle, sc)));
}
function routeKey(pts) { return pts.map(p => `${p.lon.toFixed(5)},${p.lat.toFixed(5)}`).join(';'); }
async function fetchRoad(pts) {
  const key = routeKey(pts);
  if (routeCache[key]) return routeCache[key];
  const r = await fetch(`https://router.project-osrm.org/route/v1/driving/${key}?overview=full&geometries=geojson`);
  const j = await r.json();
  if (j.code !== 'Ok' || !j.routes?.[0]) throw new Error(j.message || 'нет маршрута');
  const res = { path: j.routes[0].geometry.coordinates.map(c => [+c[1].toFixed(5), +c[0].toFixed(5)]), km: j.routes[0].distance / 1000 };
  routeCache[key] = res;
  persistCache();
  return res;
}
function tripRoutePoints(tripId, pool = data.points) {
  return sortedByDate(pool.filter(p => p.tripId === tripId && tripId));
}
function addArrows(path, color) {
  if (path.length < 2) return;
  // place arrows by real distance so they are evenly spread, direction smoothed over ~1 km
  const cum = [0];
  for (let i = 1; i < path.length; i++) cum.push(cum[i - 1] + haversine(path[i - 1], path[i]));
  const total = cum[cum.length - 1];
  if (total < 0.3) return;
  const count = Math.max(1, Math.min(8, Math.round(total / 60)));
  const at = d => { let i = cum.findIndex(c => c >= d); if (i <= 0) i = 1; const t = (d - cum[i - 1]) / ((cum[i] - cum[i - 1]) || 1); return [path[i - 1][0] + (path[i][0] - path[i - 1][0]) * t, path[i - 1][1] + (path[i][1] - path[i - 1][1]) * t]; };
  const sc = arrowScale(map.getZoom()) || 1;
  for (let k = 1; k <= count; k++) {
    const d = total * k / (count + 1), span = Math.min(1.5, total / 20);
    const a = at(Math.max(0, d - span)), b = at(Math.min(total, d + span));
    const angle = bearing(a, b);
    L.marker(at(d), { icon: arrowIcon(color, angle, sc), interactive: false, keyboard: false, color, angle }).addTo(arrowLayer);
  }
}
let routeToken = 0;
async function renderRoutes() {
  const token = ++routeToken;
  routeLayer.clearLayers(); arrowLayer.clearLayers();
  const status = $('routeStatus');
  status.hidden = true;
  if (!S().showRoutes) return;
  const fp = filteredPoints();
  const trips = [...new Set(fp.map(p => p.tripId).filter(Boolean))];
  const jobs = trips.map(id => ({ id, pts: tripRoutePoints(id, fp) })).filter(j => j.pts.length >= 2);
  if (!jobs.length) { status.textContent = 'Нужна поездка хотя бы с двумя точками.'; status.hidden = false; return; }
  let failed = 0;
  const casing = cssVar('--route-casing'), dark = theme() === 'dark';
  for (const j of jobs) {
    const color = tripColor(j.id);
    const needsFetch = !routeCache[routeKey(j.pts)];
    if (needsFetch) { status.textContent = `Строю дорогу: ${tripName(j.id)}…`; status.hidden = false; }
    let path, road = true;
    try { path = (await fetchRoad(j.pts)).path; }
    catch { failed++; road = false; path = j.pts.map(p => [p.lat, p.lon]); }
    if (token !== routeToken) return;
    L.polyline(path, { color: casing, weight: 8, opacity: dark ? .7 : .9, lineCap: 'round', lineJoin: 'round', interactive: false }).addTo(routeLayer);
    const line = L.polyline(path, { color, weight: 4, opacity: 1, dashArray: road ? null : '2 9', lineCap: 'round', lineJoin: 'round', interactive: false }).addTo(routeLayer);
    if (dark) line.getElement()?.style.setProperty('filter', `drop-shadow(0 0 4px ${color}aa)`);
    addArrows(path, color);
    if (needsFetch) await sleep(250);
  }
  if (token !== routeToken) return;
  updateArrows();
  if (failed) { status.textContent = `Сервис дорог не ответил для ${failed} ${plural(failed, 'поездки', 'поездок', 'поездок')}, показаны прямые линии.`; status.hidden = false; }
  else status.hidden = true;
}

// ---- picking a location on the map ----
function setPicking(on) {
  picking = on;
  $('map').classList.toggle('picking', on);
  $('pickBanner').hidden = !on;
  $('pickBtn').classList.toggle('active', on);
}
function showPickMarker(lat, lon) {
  if (pickMarker) map.removeLayer(pickMarker);
  pickMarker = L.marker([lat, lon], {
    draggable: true, zIndexOffset: 1000,
    icon: L.divIcon({ className: '', iconSize: [26, 26], iconAnchor: [13, 13], html: '<div class="vz-pick"></div>' }),
  }).addTo(map);
  pickMarker.on('dragend', () => { const ll = pickMarker.getLatLng(); applyPickedLocation(ll.lat, ll.lng, false); });
}
function clearPickMarker() { if (pickMarker) { map.removeLayer(pickMarker); pickMarker = null; } }
async function applyPickedLocation(lat, lon, fillNames = true) {
  $('fCoords').value = coordsText(lat, lon);
  $('fCoords').classList.remove('invalid');
  const offline = detectRegionOffline(lat, lon);
  if (offline) $('fRegion').value = offline;
  const info = await reverseGeocode(lat, lon);
  if (!info) return;
  if (fillNames && !$('fName').value.trim()) $('fName').value = info.name;
  if (fillNames && !$('fAddress').value.trim()) $('fAddress').value = info.address ? `${info.name}, ${info.address}` : info.name;
  if (!offline) { const r = normalizeRegion(info.region); if (r) $('fRegion').value = r; }
}
function onMapClick(e) {
  if (!picking) return;
  setPicking(false);
  showPickMarker(e.latlng.lat, e.latlng.lng);
  applyPickedLocation(e.latlng.lat, e.latlng.lng);
}

// ======================================================================
// Add / edit form
// ======================================================================
function renderFormSelects() {
  const cur = $('fTrip').value;
  $('fTrip').innerHTML = '<option value="">Без поездки</option>' + data.trips.map(t => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('');
  if ([...$('fTrip').options].some(o => o.value === cur)) $('fTrip').value = cur;
  if (!$('fRegion').options.length) {
    $('fRegion').innerHTML = '<option value="">Автоматически</option>' + [...REGIONS].sort((a, b) => a.localeCompare(b, 'ru')).map(r => `<option>${esc(r)}</option>`).join('');
  }
}
let formPhotos = null;   // PhotoGrid of the add/edit form
const tidyPhotos = () => { if (!readOnly) cleanupPhotos(formPhotos ? formPhotos.ids : []); };
function clearPlaceFields() {
  ['search', 'fName', 'fCoords', 'fAddress', 'fNote'].forEach(id => $(id).value = '');
  formPhotos.set([]);
  $('fRegion').value = '';
  document.querySelectorAll('.invalid').forEach(el => el.classList.remove('invalid'));
  clearPickMarker();
}
function startEdit(id) {
  const p = data.points.find(x => x.id === id);
  if (!p) return;
  editingId = id;
  switchTab('add');
  $('search').value = '';
  $('fName').value = p.name; $('fCoords').value = coordsText(p.lat, p.lon); $('fAddress').value = p.address;
  $('fDate').value = p.date; $('fRegion').value = p.region; $('fTrip').value = p.tripId; $('fNote').value = p.note;
  formPhotos.set(p.photos || []);
  $('editName').textContent = p.name;
  $('editBanner').hidden = false; $('cancelEditBtn').hidden = false;
  $('saveBtn').textContent = 'Сохранить изменения';
  showPickMarker(p.lat, p.lon);
  focusAt([p.lat, p.lon], Math.max(map.getZoom(), 11));
}
function endEdit() {
  editingId = null;
  $('editBanner').hidden = true; $('cancelEditBtn').hidden = true;
  $('saveBtn').textContent = 'Сохранить точку';
  clearPlaceFields();
  tidyPhotos();
}
async function savePoint() {
  const name = $('fName').value.trim();
  const c = parseCoords($('fCoords').value);
  const date = $('fDate').value;
  const missing = [];
  $('fName').classList.toggle('invalid', !name); if (!name) missing.push('название');
  $('fCoords').classList.toggle('invalid', !c); if (!c) missing.push($('fCoords').value.trim() ? 'координаты в понятном виде (например 55.93, 40.89)' : 'координаты');
  $('fDate').classList.toggle('invalid', !date); if (!date) missing.push('дату');
  if (date && date > todayISO()) { $('fDate').classList.add('invalid'); toast('Дата в будущем', 'Укажите дату, когда вы уже были в этом месте.'); return; }
  if (missing.length) { const f = document.querySelector('#panel-add .invalid'); f?.scrollIntoView({ block: 'center', behavior: 'smooth' }); f?.focus({ preventScroll: true }); toast('Не всё заполнено', 'Укажите ' + missing.join(', ') + '.'); return; }
  if (formPhotos.busy) { toast('Фото ещё обрабатываются', 'Подождите пару секунд и сохраните снова.', 'info'); return; }

  $('saveBtn').disabled = true;
  try {
    const region = $('fRegion').value || await regionFor(c.lat, c.lon);
    const fields = { name, address: $('fAddress').value.trim(), lat: c.lat, lon: c.lon, date, note: $('fNote').value.trim(), region, tripId: $('fTrip').value, photos: [...formPhotos.ids] };
    const wasEditing = !!editingId;
    if (wasEditing) {
      const p = data.points.find(x => x.id === editingId);
      if (p) Object.assign(p, fields, { updatedAt: Date.now() });
    } else {
      data.points.push({ id: uid(), ...fields, createdAt: Date.now(), updatedAt: Date.now() });
    }
    // make sure the saved point is visible under the current filters
    if (S().selectedTrips !== null && !S().selectedTrips.includes(fields.tripId)) S().selectedTrips.push(fields.tripId);
    if (S().year !== 'all' && !date.startsWith(S().year)) S().year = 'all';
    persist();
    if (wasEditing) { endEdit(); toast('Изменения сохранены', name, 'ok'); }
    else { clearPlaceFields(); toast('Точка добавлена', region ? `${name} · ${region}` : name, 'ok'); $('search').focus(); }
    tidyPhotos();
    refreshAll();
  } finally { $('saveBtn').disabled = false; }
}

// ---- search autocomplete ----
let sgItems = [], sgActive = -1, sgAbort = null;
const runSearch = debounce(async q => {
  if (sgAbort) sgAbort.abort();
  sgAbort = new AbortController();
  const box = $('suggest');
  try {
    const items = await searchPlaces(q, sgAbort.signal);
    sgItems = items; sgActive = -1;
    box.innerHTML = items.length
      ? items.map((it, i) => `<div class="sg-item" data-i="${i}"><div>${esc(it.name)}<small>${esc(it.address)}</small></div></div>`).join('') + '<div class="sg-note">Нет нужного? Вставьте координаты или выберите точку на карте.</div>'
      : '<div class="sg-note">Ничего не найдено. Вставьте координаты или выберите точку на карте.</div>';
    box.hidden = false;
  } catch (e) {
    if (e.name === 'AbortError') return;
    box.innerHTML = '<div class="sg-note">Поиск недоступен: нет связи с интернетом. Координаты можно вставить вручную.</div>';
    box.hidden = false;
  }
}, 350);
function chooseSuggestion(i) {
  const it = sgItems[i]; if (!it) return;
  $('fName').value = it.name;
  $('fAddress').value = it.address;
  $('fCoords').value = coordsText(it.lat, it.lon);
  $('fRegion').value = detectRegionOffline(it.lat, it.lon) || normalizeRegion(it.region) || '';
  $('search').value = it.name;
  $('suggest').hidden = true;
  ['fName', 'fCoords'].forEach(id => $(id).classList.remove('invalid'));
  showPickMarker(it.lat, it.lon);
  focusAt([it.lat, it.lon], Math.max(map.getZoom(), 12));
}

// ======================================================================
// Points list
// ======================================================================
function renderList() {
  const el = $('pointsList');
  const q = $('listSearch').value.trim().toLowerCase();
  const fp = filteredPoints().filter(p => !q || [p.name, p.address, p.note, p.region].some(x => (x || '').toLowerCase().includes(q)));
  if (!data.points.length) { el.innerHTML = `<div class="empty">${icon('pin', 30)}<b>Пока нет ни одной точки</b><br>Добавьте первое место на вкладке «Добавить».</div>`; return; }
  if (!fp.length) { el.innerHTML = `<div class="empty">${icon('search', 30)}<b>Ничего не нашлось</b><br>${q ? 'Попробуйте другой запрос.' : 'Под выбранные фильтры нет точек.'}</div>`; return; }
  const groups = new Map();
  fp.forEach(p => { if (!groups.has(p.tripId)) groups.set(p.tripId, []); groups.get(p.tripId).push(p); });
  const order = [...groups.keys()].sort((a, b) => {
    if (a === NO_TRIP) return 1; if (b === NO_TRIP) return -1;
    const da = sortedByDate(groups.get(a))[0].date || '', db = sortedByDate(groups.get(b))[0].date || '';
    return db.localeCompare(da);
  });
  el.innerHTML = order.map(k => {
    const list = sortedByDate(groups.get(k));
    const dates = list.map(p => p.date).filter(Boolean);
    const span = dates.length ? (dates[0] === dates[dates.length - 1] ? fmtDate(dates[0]) : `${fmtDate(dates[0])} – ${fmtDate(dates[dates.length - 1])}`) : '';
    const c = tripColor(k), trip = k ? tripById(k) : null;
    return `<div class="trip-group" style="--tc:${c}">
      <div class="trip-head" data-trip="${esc(k)}" title="Показать поездку на карте">
        <span class="trip-swatch" style="background:${c}"></span>
        <div class="tt"><div class="title">${esc(tripName(k))}</div>
          <div class="meta">${list.length} ${plural(list.length, 'точка', 'точки', 'точек')}${span ? ', ' + span : ''}</div></div>
        ${k ? `<div class="trip-acts">
          <button class="mini-btn" data-share="${esc(k)}" title="Поделиться поездкой">${icon('share', 16)}</button>
          <button class="mini-btn" data-edittrip="${esc(k)}" title="Название, комментарий и фото поездки">${icon('edit', 16)}</button>
          <button class="mini-btn danger" data-deltrip="${esc(k)}" title="Удалить поездку">${icon('trash', 16)}</button></div>` : ''}
      </div>
      ${trip?.comment ? `<div class="trip-comment">${esc(trip.comment)}</div>` : ''}
      ${trip?.photos?.length ? `<div class="trip-photos">${trip.photos.map((id, i) => `<img data-photo="${esc(id)}" data-tlb="${esc(k)}" data-i="${i}" alt="">`).join('')}</div>` : ''}
      <div class="timeline">${list.map(p => `<div class="pt" data-id="${esc(p.id)}" title="Показать на карте">
        <span class="rail"></span>
        <div class="body"><div class="nm"><span>${esc(p.name)}</span>${p.photos?.length ? `<span class="ph-count" title="Фото">${icon('camera', 13)}${p.photos.length}</span>` : ''}</div>
          <div class="mt">${[fmtDate(p.date), p.region || p.address].filter(Boolean).map(esc).join(', ')}</div></div>
        <div class="acts"><button class="mini-btn" data-edit="${esc(p.id)}" title="Изменить точку">${icon('edit', 15)}</button><button class="mini-btn danger" data-del="${esc(p.id)}" title="Удалить точку">${icon('trash', 15)}</button></div>
      </div>`).join('')}</div>
    </div>`;
  }).join('');
  hydratePhotos(el);
}
async function openTripDialog(tripId) {
  const t = tripById(tripId); if (!t) return;
  let grid;
  const { action, el } = await dialog({
    icon: 'route', title: 'Поездка',
    html: `<div class="field"><label class="lbl" for="tdName">Название</label><input id="tdName" value="${esc(t.name)}"></div>
      <div class="field"><label class="lbl" for="tdComment">Комментарий к поездке</label><textarea id="tdComment" rows="4" placeholder="Как прошла поездка, с кем, что запомнилось">${esc(t.comment || '')}</textarea></div>
      <div class="field"><label class="lbl">Фото поездки</label><div id="tdPhotos"></div>
      <p class="hint">Фото конкретного места лучше добавлять в саму точку, тогда они появятся на карте.</p></div>`,
    buttons: [
      { label: 'Сохранить', value: 'save', style: 'primary', validate: el => {
        const v = el.querySelector('#tdName').value.trim();
        if (!v) { el.querySelector('#tdName').classList.add('invalid'); return false; }
        if (grid.busy) { toast('Фото ещё обрабатываются', 'Подождите пару секунд.', 'info'); return false; }
        return true;
      } },
      { label: 'Отмена', value: null, style: 'ghost' },
    ],
    onInit: el => { grid = new PhotoGrid(el.querySelector('#tdPhotos'), { title: () => t.name }); grid.set(t.photos || []); el.querySelector('#tdName').focus(); },
  });
  if (action === 'save') {
    t.name = el.querySelector('#tdName').value.trim();
    t.comment = el.querySelector('#tdComment').value.trim();
    t.photos = [...grid.ids];
    persist(); refreshAll();
    toast('Поездка сохранена', t.name, 'ok');
  }
  tidyPhotos();
}
async function deleteTrip(tripId) {
  const t = tripById(tripId); if (!t) return;
  const n = data.points.filter(p => p.tripId === tripId).length;
  const choice = await modal({
    icon: 'trash', tone: 'danger', title: `Удалить поездку «${t.name}»?`,
    text: n ? `В ней ${n} ${plural(n, 'точка', 'точки', 'точек')}.` : 'В ней нет точек.',
    buttons: [
      ...(n ? [{ label: 'Оставить точки без поездки', value: 'keep', style: 'primary' }, { label: 'Удалить вместе с точками', value: 'all', style: 'danger' }]
            : [{ label: 'Удалить', value: 'keep', style: 'danger' }]),
      { label: 'Отмена', value: null, style: 'ghost' },
    ],
  });
  if (!choice) return;
  if (choice === 'all') data.points = data.points.filter(p => p.tripId !== tripId);
  else data.points.forEach(p => { if (p.tripId === tripId) p.tripId = NO_TRIP; });
  data.trips = data.trips.filter(x => x.id !== tripId);
  if (S().selectedTrips) { S().selectedTrips = S().selectedTrips.filter(k => k !== tripId); if (choice === 'keep' && !S().selectedTrips.includes(NO_TRIP)) S().selectedTrips.push(NO_TRIP); }
  persist(); refreshAll(); tidyPhotos();
  toast('Поездка удалена', t.name, 'ok');
}
async function deletePoint(id) {
  const p = data.points.find(x => x.id === id); if (!p) return;
  const ok = await modal({ icon: 'trash', tone: 'danger', title: `Удалить «${p.name}»?`, text: 'Вернуть точку можно будет только из запасной копии.', buttons: [{ label: 'Удалить', value: true, style: 'danger' }, { label: 'Отмена', value: null, style: 'ghost' }] });
  if (!ok) return;
  data.points = data.points.filter(x => x.id !== id);
  if (editingId === id) endEdit();
  persist(); refreshAll(); tidyPhotos();
  toast('Точка удалена', p.name, 'ok');
}

// ======================================================================
// Statistics & achievements
// ======================================================================
function tripKm(tripId, pool) {
  const pts = tripRoutePoints(tripId, pool);
  if (pts.length < 2) return { km: 0, road: false };
  const cached = routeCache[routeKey(pts)];
  if (cached) return { km: cached.km, road: true };
  let km = 0;
  for (let i = 1; i < pts.length; i++) km += haversine([pts[i - 1].lat, pts[i - 1].lon], [pts[i].lat, pts[i].lon]);
  return { km, road: false };
}
function bar(label, value, valueText, max, color = 'var(--accent)') {
  return `<div class="bar"><div class="bl"><span>${label}</span><span>${valueText}</span></div><div class="track"><div class="fill" style="width:${max ? Math.max(3, value / max * 100) : 0}%;background:${color}"></div></div></div>`;
}

// ---- mini map of Russia (Albers conic, projected once and cached) ----
let miniRussia = null;
function buildMiniRussia() {
  if (miniRussia || !window.RU_REGION_SHAPES) return miniRussia;
  const rad = Math.PI / 180, lon0 = 100 * rad, p1 = 52 * rad, p2 = 68 * rad, p0 = 60 * rad;
  const n = (Math.sin(p1) + Math.sin(p2)) / 2, C = Math.cos(p1) ** 2 + 2 * n * Math.sin(p1), r0 = Math.sqrt(C - 2 * n * Math.sin(p0)) / n;
  const proj = ([lon, lat]) => {
    if (lon < 0) lon += 360;                          // Chukotka crosses 180°
    const r = Math.sqrt(C - 2 * n * Math.sin(lat * rad)) / n, t = n * (lon * rad - lon0);
    return [r * Math.sin(t), -(r0 - r * Math.cos(t))];
  };
  const regions = window.RU_REGION_SHAPES.features.map(f => {
    const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    return { name: f.properties.name, rings: polys.flatMap(p => p.map(ring => ring.map(proj))) };
  });
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  regions.forEach(r => r.rings.forEach(ring => ring.forEach(([x, y]) => { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, -y); y1 = Math.max(y1, -y); })));
  const W = 1000, k = W / (x1 - x0), H = Math.round((y1 - y0) * k);
  regions.forEach(r => {
    r.d = r.rings.map(ring => {
      let out = '', lx = null, ly = null, cnt = 0;
      ring.forEach(([x, y], i) => {
        const px = (x - x0) * k, py = (-y - y0) * k;
        if (i && i < ring.length - 1 && Math.abs(px - lx) + Math.abs(py - ly) < 3) return;
        out += (cnt ? 'L' : 'M') + px.toFixed(1) + ' ' + py.toFixed(1); lx = px; ly = py; cnt++;
      });
      return cnt > 2 ? out + 'Z' : '';
    }).join('');
    delete r.rings;
  });
  miniRussia = { W, H, regions };
  return miniRussia;
}
function miniRussiaSvg(visited) {
  const m = buildMiniRussia(); if (!m) return '';
  return `<svg class="mini-russia" viewBox="-6 -6 ${m.W + 12} ${m.H + 12}" role="img" aria-label="Карта посещённых регионов">
    ${m.regions.map(r => `<path class="${visited.has(r.name) ? 'on' : ''}" d="${r.d}"><title>${esc(r.name)}${visited.has(r.name) ? ': ' + visited.get(r.name) + ' ' + plural(visited.get(r.name), 'точка', 'точки', 'точек') : ''}</title></path>`).join('')}
  </svg>`;
}
function computeAchievements() {
  const P = data.points;
  const regs = visitedRegions(P);
  const years = new Set(P.map(p => (p.date || '').slice(0, 4)).filter(Boolean));
  let longestDays = 0, farthest = 0;
  data.trips.forEach(t => {
    const pts = tripRoutePoints(t.id);
    if (pts.length >= 2 && pts[0].date) {
      longestDays = Math.max(longestDays, (new Date(pts[pts.length - 1].date) - new Date(pts[0].date)) / 864e5 + 1);
      for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) farthest = Math.max(farthest, haversine([pts[i].lat, pts[i].lon], [pts[j].lat, pts[j].lon]));
    }
  });
  const pct = REGIONS.length ? regs.size / REGIONS.length : 0;
  const maxLat = Math.max(-90, ...P.map(p => p.lat)), maxLon = Math.max(-180, ...P.map(p => p.lon)), minLat = Math.min(90, ...P.map(p => p.lat));
  return [
    { ic: 'flag', n: 'Первые шаги', d: 'Первая точка на карте', ok: P.length >= 1 },
    { ic: 'pin', n: 'Пять мест', d: '5 точек', ok: P.length >= 5 },
    { ic: 'map', n: 'Двадцать мест', d: '20 точек', ok: P.length >= 20 },
    { ic: 'bag', n: 'Сотня', d: '100 точек', ok: P.length >= 100 },
    { ic: 'mountain', n: 'Свой край', d: 'Первый регион', ok: regs.size >= 1 },
    { ic: 'compass', n: 'Десяток регионов', d: '10 регионов', ok: regs.size >= 10 },
    { ic: 'globe', n: 'Четверть страны', d: '25% регионов', ok: pct >= .25 },
    { ic: 'trophy', n: 'Половина России', d: '50% регионов', ok: pct >= .5 },
    { ic: 'route', n: 'Коллекционер', d: '3 поездки', ok: data.trips.length >= 3 },
    { ic: 'calendar', n: 'Марафонец', d: 'Поездка от 7 дней', ok: longestDays >= 7 },
    { ic: 'plane', n: 'Дальний путь', d: '1000 км в одной поездке', ok: farthest >= 1000 },
    { ic: 'repeat', n: 'Из года в год', d: 'Точки за 3 разных года', ok: years.size >= 3 },
    { ic: 'snow', n: 'За полярным кругом', d: 'Точка севернее 66,5°', ok: maxLat >= 66.56 },
    { ic: 'sunrise', n: 'Восток зовёт', d: 'Точка восточнее 100°', ok: maxLon >= 100 },
    { ic: 'wave', n: 'На юг', d: 'Точка южнее 45°', ok: P.length > 0 && minLat <= 45 },
    { ic: 'camera', n: 'Фотограф', d: '20 фото', ok: referencedPhotoIds().size >= 20 },
    { ic: 'pen', n: 'Летописец', d: 'Комментарии к 3 поездкам', ok: data.trips.filter(t => t.comment).length >= 3 },
  ];
}
function renderStats() {
  const el = $('stats');
  if (!data.points.length) { el.innerHTML = `<div class="st-hero">${miniRussiaSvg(new Map())}</div><div class="empty">${icon('chart', 30)}<b>Здесь появится статистика</b><br>Добавьте первую точку, и регион загорится на карте.</div>`; return; }
  const fp = filteredPoints();
  const regs = visitedRegions(fp);
  const pct = REGIONS.length ? regs.size / REGIONS.length * 100 : 0;
  const isFiltered = S().selectedTrips !== null || S().year !== 'all';

  // by trip
  const tripKeys = [...new Set(fp.map(p => p.tripId))];
  const tripRows = tripKeys.map(k => ({ k, n: fp.filter(p => p.tripId === k).length, ...(k ? tripKm(k, fp) : { km: 0, road: false }) }))
    .sort((a, b) => b.n - a.n);
  const maxN = Math.max(1, ...tripRows.map(r => r.n));
  const totalKm = tripRows.reduce((s, r) => s + r.km, 0);
  const anyStraight = tripRows.some(r => r.km > 0 && !r.road);

  // by year
  const byYear = {};
  fp.forEach(p => { if (p.date) { const y = p.date.slice(0, 4); byYear[y] = (byYear[y] || 0) + 1; } });
  const years = Object.keys(byYear).sort();
  const maxY = Math.max(1, ...Object.values(byYear));

  // regions
  const regList = [...regs.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ru'));
  const notVisited = REGIONS.filter(r => !regs.has(r)).sort((a, b) => a.localeCompare(b, 'ru'));
  const noRegion = fp.filter(p => !p.region).length;

  // lifetime
  const all = data.points, dated = sortedByDate(all.filter(p => p.date));
  const allKm = data.trips.reduce((s, t) => s + tripKm(t.id).km, 0);
  const ach = computeAchievements(), achDone = ach.filter(a => a.ok).length;

  const pctTxt = pct.toLocaleString('ru-RU', { maximumFractionDigits: pct < 10 ? 1 : 0 });
  el.innerHTML = `
    <div class="st-hero">${miniRussiaSvg(regs)}</div>
    <div class="st-big"><span class="num">${regs.size}</span><span class="of">из ${REGIONS.length} регионов России, это <b>${pctTxt}%</b></span></div>
    <div class="progress"><div style="width:${pct}%"></div></div>
    ${isFiltered ? '<div class="st-scope">Считается по выбранным поездкам и году.</div>' : ''}
    ${noRegion ? `<div class="hint">${noRegion} ${plural(noRegion, 'точка', 'точки', 'точек')} без региона: за пределами России или регион не определился.</div>` : ''}

    <div class="kpis">
      <div class="kpi"><div class="v">${fp.length}</div><div class="k">${plural(fp.length, 'точка', 'точки', 'точек')}</div></div>
      <div class="kpi"><div class="v">${tripKeys.filter(Boolean).length}</div><div class="k">${plural(tripKeys.filter(Boolean).length, 'поездка', 'поездки', 'поездок')}</div></div>
      <div class="kpi"><div class="v">${Math.round(totalKm).toLocaleString('ru-RU')}</div><div class="k">км${anyStraight ? ', часть по прямой' : ' в пути'}</div></div>
    </div>

    ${tripRows.length ? `<div class="sec">По поездкам</div>` + tripRows.map(r =>
      bar(`<span class="dot" style="background:${tripColor(r.k)}"></span>${esc(tripName(r.k))}`,
        r.n, `${r.n} ${plural(r.n, 'точка', 'точки', 'точек')}${r.km ? ', ' + fmtKm(r.km) + (r.road ? '' : '*') : ''}`, maxN, tripColor(r.k))).join('')
      + (anyStraight ? '<div class="hint">* По прямой между точками. Включите «Показать дороги маршрутов» в слоях карты, чтобы посчитать по дорогам.</div>' : '') : ''}

    ${years.length ? `<div class="sec">По годам</div>` + years.map(y => bar(y, byYear[y], `${byYear[y]} ${plural(byYear[y], 'точка', 'точки', 'точек')}`, maxY)).join('') : ''}

    <div class="sec">Посещённые регионы <small>${regList.length}</small></div>
    <div class="tags">${regList.map(([r, n]) => `<span class="tag">${esc(r)}<b>${n}</b></span>`).join('') || '<span class="hint">Пока нет</span>'}</div>
    ${notVisited.length ? `<details class="more"><summary>${icon('chevron', 14)}Где ещё не были: ${notVisited.length}</summary><div class="tags dim">${notVisited.map(r => `<span class="tag">${esc(r)}</span>`).join('')}</div></details>` : ''}

    <div class="sec">Ачивки <small>${achDone} из ${ach.length}</small></div>
    <div class="achv">${ach.map(a => `<div class="ach ${a.ok ? '' : 'locked'}" title="${esc(a.d)}">
      ${a.ok ? '' : `<span class="lk">${icon('lock', 12)}</span>`}<div class="badge">${icon(a.ic, 20)}</div>
      <div class="an">${esc(a.n)}</div><div class="ad">${esc(a.d)}</div></div>`).join('')}</div>

    <div class="sec">За всё время</div>
    <div class="kv"><span>Точек</span><span>${all.length}</span></div>
    <div class="kv"><span>Поездок</span><span>${data.trips.length}</span></div>
    <div class="kv"><span>Регионов</span><span>${visitedRegions(all).size} из ${REGIONS.length}</span></div>
    <div class="kv"><span>Пробег по поездкам</span><span>${fmtKm(allKm)}</span></div>
    <div class="kv"><span>Фото</span><span>${referencedPhotoIds().size}</span></div>
    ${dated.length ? `<div class="kv"><span>Первая точка</span><span>${fmtDate(dated[0].date)}</span></div><div class="kv"><span>Последняя точка</span><span>${fmtDate(dated[dated.length - 1].date)}</span></div>` : ''}
  `;
}

// ======================================================================
// Wiring
// ======================================================================
function switchTab(tab) {
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  ['add', 'list', 'stats'].forEach(t => $('panel-' + t).hidden = t !== tab);
  if (S().tab !== tab) setSetting('tab', tab);
}
function updateCounters() {
  const n = data.points.length, t = data.trips.length, r = visitedRegions(data.points).size;
  $('counters').innerHTML = [[n, 'точка', 'точки', 'точек'], [t, 'поездка', 'поездки', 'поездок'], [r, 'регион', 'региона', 'регионов']]
    .map(([v, a, b, c]) => `<span><b>${v}</b>${plural(v, a, b, c)}</span>`).join('');
}

// ---- theme & static icons ----
function applyTheme(t) {
  t = t === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem('vezde.theme', t); } catch {}
  const b = $('themeBtn');
  b.innerHTML = icon(t === 'dark' ? 'sun' : 'moon', 18);
  b.title = t === 'dark' ? 'Светлая тема' : 'Тёмная тема';
  if (map) { setBase(S().baseLayer); renderRegions(); renderRoutes(); }
}
function paintStaticIcons() {
  $('logo').insertAdjacentHTML('afterbegin', brandMark(30));
  $('tourBtn').innerHTML = icon('help', 19);
  $('menuBtn').innerHTML = icon('more', 19);
  const menu = { export: ['share', 'Поделиться или сохранить в файл'], import: ['download', 'Загрузить из файла'], folder: ['folder', 'Открыть папку с данными'], updates: ['repeat', 'Проверить обновления'], uninstall: ['trash', 'Удалить Vezde с компьютера'] };
  $('menuVer').textContent = `Vezde ${APP_VERSION}`;
  document.querySelectorAll('#menu [data-act]').forEach(b => { const [ic, t] = menu[b.dataset.act]; b.innerHTML = icon(ic, 17) + t; });
  const tabs = { add: ['plus', 'Добавить'], list: ['list', 'Точки'], stats: ['chart', 'Статистика'] };
  document.querySelectorAll('.tab').forEach(b => { const [ic, t] = tabs[b.dataset.tab]; b.innerHTML = icon(ic, 16) + t; });
  $('searchIc').innerHTML = icon('search', 16);
  $('listSearchIc').innerHTML = icon('search', 16);
  $('pickBtn').innerHTML = icon('target', 16) + 'На карте';
  $('pickBtn').title = 'Указать место щелчком по карте';
  $('newTripBtn').innerHTML = icon('plus', 16) + 'Новая';
  $('newTripBtn').title = 'Создать поездку';
  $('layersBtn').innerHTML = icon('layers', 20);
  $('pickIc').innerHTML = icon('target', 16);
  document.querySelector('#editBanner .eb-ic').innerHTML = icon('edit', 16);
}
function refreshAll(fit = false) {
  renderFilters(); renderFormSelects(); updateCounters();
  renderMarkers(fit); renderRegions(); renderRoutes();
  renderList(); renderStats();
}

function bindEvents() {
  formPhotos = new PhotoGrid($('fPhotos'), {
    title: () => $('fName').value.trim(),
    onExif: async x => {
      const filled = [];
      if (x.lat != null && !parseCoords($('fCoords').value)) {
        showPickMarker(x.lat, x.lon);
        focusAt([x.lat, x.lon], Math.max(map.getZoom(), 12));
        await applyPickedLocation(x.lat, x.lon);
        filled.push('место');
      }
      if (x.date && !$('fDate').value && x.date <= todayISO()) { $('fDate').value = x.date; $('fDate').classList.remove('invalid'); filled.push('дату'); }
      if (filled.length) toast('Взял из фото', `Подставил ${filled.join(' и ')} — проверьте.`, 'info');
    },
  });
  document.querySelectorAll('.tab').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));

  // menu
  $('tourBtn').addEventListener('click', () => Tour.start());
  $('themeBtn').addEventListener('click', () => { const t = theme() === 'dark' ? 'light' : 'dark'; setSetting('theme', t); applyTheme(t); });
  $('menuBtn').addEventListener('click', e => { e.stopPropagation(); $('menu').hidden = !$('menu').hidden; $('menuBtn').setAttribute('aria-expanded', !$('menu').hidden); });
  $('menu').addEventListener('click', e => {
    const act = e.target.dataset.act; if (!act) return;
    $('menu').hidden = true;
    if (act === 'export') openShareDialog(); else if (act === 'import') openImportDialog(); else if (act === 'folder') Store.openFolder(); else if (act === 'uninstall') Uninstaller.start(); else if (act === 'updates') Updates.check(true);
  });
  if (!IS_NATIVE) document.querySelectorAll('.native-only').forEach(el => el.hidden = true);

  // filters
  $('tripPickerBtn').addEventListener('click', e => { e.stopPropagation(); $('tripPicker').hidden = !$('tripPicker').hidden; });
  $('tripChecks').addEventListener('change', e => {
    const k = e.target.dataset.k; if (k === undefined) return;
    const set = selectedKeys(); e.target.checked ? set.add(k) : set.delete(k); setSelected(set);
  });
  $('tripAll').addEventListener('click', () => setSelected(new Set(allTripKeys())));
  $('tripNone').addEventListener('click', () => setSelected(new Set()));
  $('yearFilter').addEventListener('change', e => { setSetting('year', e.target.value); refreshAll(true); });
  document.addEventListener('click', e => {
    if (!e.target.closest('.trip-picker')) $('tripPicker').hidden = true;
    if (!e.target.closest('.menu-wrap')) { $('menu').hidden = true; $('menuBtn').setAttribute('aria-expanded', false); }
    if (!e.target.closest('.map-controls')) { $('layersPanel').hidden = true; $('layersBtn').setAttribute('aria-expanded', false); }
    if (!e.target.closest('.search-wrap')) $('suggest').hidden = true;
  });

  // form
  $('search').addEventListener('input', () => { const q = $('search').value.trim(); if (q.length < 3) { $('suggest').hidden = true; return; } runSearch(q); });
  $('search').addEventListener('keydown', e => {
    const items = $('suggest').querySelectorAll('.sg-item');
    if ($('suggest').hidden || !items.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      sgActive = (sgActive + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items.forEach((it, i) => it.classList.toggle('active', i === sgActive));
      items[sgActive].scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') { e.preventDefault(); chooseSuggestion(Math.max(0, sgActive)); }
    else if (e.key === 'Escape') $('suggest').hidden = true;
  });
  $('suggest').addEventListener('click', e => { const it = e.target.closest('.sg-item'); if (it) chooseSuggestion(+it.dataset.i); });
  $('fCoords').addEventListener('change', () => {
    const c = parseCoords($('fCoords').value);
    $('fCoords').classList.toggle('invalid', !c && !!$('fCoords').value.trim());
    if (!c) return;
    $('fCoords').value = coordsText(c.lat, c.lon);
    showPickMarker(c.lat, c.lon);
    focusAt([c.lat, c.lon], Math.max(map.getZoom(), 12));
    applyPickedLocation(c.lat, c.lon);
  });
  $('fCoords').addEventListener('paste', () => setTimeout(() => $('fCoords').dispatchEvent(new Event('change')), 0));
  ['fName', 'fDate'].forEach(id => $(id).addEventListener('input', () => $(id).classList.remove('invalid')));
  $('fDate').max = todayISO();
  $('pickBtn').addEventListener('click', () => setPicking(!picking));
  $('pickCancel').addEventListener('click', () => setPicking(false));
  $('newTripBtn').addEventListener('click', () => { $('newTripRow').hidden = !$('newTripRow').hidden; if (!$('newTripRow').hidden) $('newTripName').focus(); });
  const doCreateTrip = () => {
    const name = $('newTripName').value.trim();
    if (!name) { $('newTripName').classList.add('invalid'); return; }
    if (data.trips.some(t => t.name.toLowerCase() === name.toLowerCase())) { toast('Такая поездка уже есть', name); return; }
    const t = createTrip(name);
    $('newTripName').value = ''; $('newTripRow').hidden = true; $('newTripName').classList.remove('invalid');
    renderFilters(); renderFormSelects(); updateCounters();
    $('fTrip').value = t.id;
    toast('Поездка создана', name, 'ok');
  };
  $('newTripCreate').addEventListener('click', doCreateTrip);
  $('newTripName').addEventListener('keydown', e => { if (e.key === 'Enter') doCreateTrip(); if (e.key === 'Escape') $('newTripRow').hidden = true; });
  $('saveBtn').addEventListener('click', savePoint);
  $('cancelEditBtn').addEventListener('click', endEdit);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && picking) setPicking(false);
    if (e.key === 'Escape' && !$('layersPanel').hidden) { $('layersPanel').hidden = true; $('layersBtn').setAttribute('aria-expanded', false); }
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !$('panel-add').hidden) savePoint();
  });

  // list
  $('listSearch').addEventListener('input', debounce(renderList, 150));
  $('pointsList').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (b?.dataset.edit) return startEdit(b.dataset.edit);
    if (b?.dataset.del) return deletePoint(b.dataset.del);
    if (b?.dataset.edittrip) return openTripDialog(b.dataset.edittrip);
    if (b?.dataset.share) return openShareDialog([b.dataset.share]);
    const tlb = e.target.closest('[data-tlb]');
    if (tlb) { const t = tripById(tlb.dataset.tlb); return Lightbox.open(t.photos, +tlb.dataset.i, t.name); }
    if (b?.dataset.deltrip) return deleteTrip(b.dataset.deltrip);
    if (e.target.closest('input')) return;
    const row = e.target.closest('.pt');
    if (row) { const m = markerById.get(row.dataset.id); if (m) { focusAt(m.getLatLng(), Math.max(map.getZoom(), 12)); m.openPopup(); } return; }
    const head = e.target.closest('.trip-head');
    if (head) { const pts = filteredPoints().filter(p => p.tripId === head.dataset.trip); if (pts.length) fitPoints(pts.map(p => [p.lat, p.lon]), 12); }
  });

  // map panel
  $('layersBtn').addEventListener('click', () => { const p = $('layersPanel'); p.hidden = !p.hidden; $('layersBtn').setAttribute('aria-expanded', !p.hidden); });
  $('baseList').addEventListener('click', e => { const b = e.target.closest('[data-base]'); if (!b) return; setBase(b.dataset.base); setSetting('baseLayer', b.dataset.base); });
  $('showRegions').addEventListener('change', e => { setSetting('showRegions', e.target.checked); renderRegions(); });
  $('showRoutes').addEventListener('change', e => { setSetting('showRoutes', e.target.checked); renderRoutes(); renderStats(); });
}

async function main() {
  try { await Store.init(); } catch (e) { console.error(e); }
  const loaded = await Store.loadData();
  const loadedFormat = loaded ? (Number(loaded.version) || 1) : DATA_FORMAT;
  if (loadedFormat > DATA_FORMAT) readOnly = true;
  if (loaded) data = normalizeData(loaded);
  routeCache = (await Store.loadCache()) || {};
  try { await PhotoStore.init(); } catch (e) { console.error('photos', e); }
  if (IS_NATIVE) {
    Neutralino.events.on('windowClose', async () => { if (!window.__vezdeUninstalling) await flushSave(); Neutralino.app.exit(); });
    const prevVer = S().lastVersion;
    // a new version (or a new data format) starts with a safety copy of the old data
    if (loaded && (loadedFormat < DATA_FORMAT || prevVer !== APP_VERSION)) await Store.dailyBackup(normalizeData(loaded), `before-update-${APP_VERSION}`);
    if (!readOnly && (prevVer !== APP_VERSION || loadedFormat < DATA_FORMAT)) {
      S().lastVersion = APP_VERSION; persist();
      if (prevVer && cmpVersion(APP_VERSION, prevVer) > 0) setTimeout(() => toast(`Vezde обновлена до ${APP_VERSION}`, 'Все точки, поездки и фото на месте.', 'ok'), 1400);
    }
    Updates.cleanup();
    Store.dailyBackup(data);
    Uninstaller.ensureFile();
  }
  $('showRegions').checked = !!S().showRegions;
  $('showRoutes').checked = !!S().showRoutes;
  paintStaticIcons();
  applyTheme(S().theme);
  initMap();
  bindEvents();
  switchTab(S().tab || 'add');
  refreshAll(!S().view);
  setSaveState('ok');
  if (loaded && !readOnly) tidyPhotos();
  if (readOnly) setSaveState('readonly');
  if (readOnly) setTimeout(() => modal({ icon: 'alert', title: 'Данные от более новой версии Vezde',
    text: 'Ваши точки сохранены программой новее, чем эта. Чтобы ничего не испортить, Vezde открыта только для просмотра: изменения не сохранятся.\nСкачайте последнюю версию, и всё заработает как обычно.',
    buttons: [{ label: 'Скачать новую версию', value: 1, style: 'primary' }, { label: 'Только посмотреть', value: null, style: 'ghost' }] })
    .then(v => { if (v) Updates.openReleasePage(); }), 900);
  if (Store.migrated) setTimeout(() => toast('Данные перенесены', 'Теперь они хранятся в папке AppData\\Vezde, программу можно перемещать куда угодно.', 'ok'), 1200);
  if (IS_NATIVE) setTimeout(() => Updates.check(false), 4000);
  if (!S().tourDone) setTimeout(() => Tour.start(), 700);
  window.addEventListener('beforeunload', () => { if (saveTimer && !window.__vezdeUninstalling) flushSave(); });
}
main();
