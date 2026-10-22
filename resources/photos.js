'use strict';
/* Photos: processing (resize, HEIC, EXIF), storage (data/photos or IndexedDB), photo grid component, lightbox.
   Loaded before app.js; uses app.js globals only inside functions. */

const PHOTO_FULL = 1920, PHOTO_THUMB = 420;

// ----------------------------------------------------------------------
// Storage
// ----------------------------------------------------------------------
const PhotoStore = {
  urls: new Map(),           // key "id|t" -> blob URL
  db: null,

  get dir() { return Store.dir + '/photos'; },
  file(id, thumb) { return `${this.dir}/${id}${thumb ? '_t' : ''}.jpg`; },

  async init() {
    if (IS_NATIVE) { await Store.ensureDir(this.dir); return; }
    this.db = await new Promise((res, rej) => {
      const r = indexedDB.open('travelmap-photos', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('p');
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
  },
  idb(mode, fn) {
    return new Promise((res, rej) => {
      const tx = this.db.transaction('p', mode); const req = fn(tx.objectStore('p'));
      tx.oncomplete = () => res(req?.result); tx.onerror = () => rej(tx.error);
    });
  },
  async put(id, full, thumb) {
    if (IS_NATIVE) {
      await Neutralino.filesystem.writeBinaryFile(this.file(id, false), await full.arrayBuffer());
      await Neutralino.filesystem.writeBinaryFile(this.file(id, true), await thumb.arrayBuffer());
    } else {
      await this.idb('readwrite', s => { s.put(full, id); return s.put(thumb, id + '_t'); });
    }
  },
  async getBlob(id, thumb) {
    if (IS_NATIVE) return new Blob([await Neutralino.filesystem.readBinaryFile(this.file(id, thumb))], { type: 'image/jpeg' });
    const b = await this.idb('readonly', s => s.get(id + (thumb ? '_t' : '')));
    if (!b) throw new Error('нет файла');
    return b;
  },
  async url(id, thumb) {
    const key = id + (thumb ? '|t' : '|f');
    if (this.urls.has(key)) return this.urls.get(key);
    const u = URL.createObjectURL(await this.getBlob(id, thumb));
    this.urls.set(key, u);
    return u;
  },
  async remove(id) {
    for (const t of [false, true]) { const k = id + (t ? '|t' : '|f'); if (this.urls.has(k)) { URL.revokeObjectURL(this.urls.get(k)); this.urls.delete(k); } }
    try {
      if (IS_NATIVE) { for (const t of [false, true]) { try { await Neutralino.filesystem.remove(this.file(id, t)); } catch {} } }
      else await this.idb('readwrite', s => { s.delete(id); return s.delete(id + '_t'); });
    } catch {}
  },
  async listIds() {
    if (IS_NATIVE) {
      const e = await Neutralino.filesystem.readDirectory(this.dir).catch(() => []);
      return [...new Set(e.filter(x => x.type === 'FILE' && /\.jpg$/i.test(x.entry)).map(x => x.entry.replace(/(_t)?\.jpg$/i, '')))];
    }
    const keys = await this.idb('readonly', s => s.getAllKeys());
    return [...new Set((keys || []).map(k => String(k).replace(/_t$/, '')))];
  },
  async dataURL(id, thumb) {
    const b = await this.getBlob(id, thumb);
    return new Promise(res => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(b); });
  },
  async putDataURL(id, fullURL, thumbURL) {
    const toBlob = async u => (await fetch(u)).blob();
    await this.put(id, await toBlob(fullURL), await toBlob(thumbURL || fullURL));
  },
};

/** All photo ids referenced from data. */
function referencedPhotoIds() {
  const s = new Set();
  data.points.forEach(p => (p.photos || []).forEach(id => s.add(id)));
  data.trips.forEach(t => (t.photos || []).forEach(id => s.add(id)));
  return s;
}
/** Remove photo files no longer referenced by any point or trip (except ones currently in an open form). */
async function cleanupPhotos(keep = []) {
  try {
    const used = referencedPhotoIds(); keep.forEach(id => used.add(id));
    for (const id of await PhotoStore.listIds()) if (!used.has(id)) await PhotoStore.remove(id);
  } catch (e) { console.warn('cleanup', e); }
}

// ----------------------------------------------------------------------
// Processing
// ----------------------------------------------------------------------
let heicLoading = null;
function loadHeic() {
  if (window.heic2any) return Promise.resolve();
  if (!heicLoading) heicLoading = new Promise((res, rej) => {
    const s = document.createElement('script'); s.src = 'vendor/heic2any.js'; s.onload = res; s.onerror = () => rej(new Error('heic'));
    document.head.appendChild(s);
  });
  return heicLoading;
}
const isHeic = f => /\.(heic|heif)$/i.test(f.name || '') || /image\/hei[cf]/i.test(f.type || '');

async function readExif(file) {
  try {
    const x = (await window.exifr.parse(file)) || {};
    const dt = x.DateTimeOriginal || x.CreateDate;
    const date = dt instanceof Date && !isNaN(dt) ? `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}` : '';
    const ok = isFinite(x.latitude) && isFinite(x.longitude) && !(x.latitude === 0 && x.longitude === 0);
    return { date, lat: ok ? x.latitude : null, lon: ok ? x.longitude : null };
  } catch { return {}; }
}
async function resizeTo(bitmap, max, quality) {
  const k = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * k), h = Math.round(bitmap.height * k);
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d'); ctx.imageSmoothingQuality = 'high'; ctx.drawImage(bitmap, 0, 0, w, h);
  return new Promise(res => c.toBlob(res, 'image/jpeg', quality));
}
/** Converts any supported image file to stored JPEGs. Returns {id, exif}. */
async function importPhotoFile(file) {
  const exif = await readExif(file);
  let src = file;
  if (isHeic(file)) {
    await loadHeic();
    const out = await window.heic2any({ blob: file, toType: 'image/jpeg', quality: .92 });
    src = Array.isArray(out) ? out[0] : out;
  }
  const bmp = await createImageBitmap(src, { imageOrientation: 'from-image' });
  const full = await resizeTo(bmp, PHOTO_FULL, .86);
  const thumb = await resizeTo(bmp, PHOTO_THUMB, .8);
  bmp.close?.();
  const id = 'ph' + uid();
  await PhotoStore.put(id, full, thumb);
  return { id, exif };
}

/** Sets src on every <img data-photo> inside root. */
function hydratePhotos(root) {
  root.querySelectorAll('img[data-photo]:not([src])').forEach(async img => {
    try { img.src = await PhotoStore.url(img.dataset.photo, img.dataset.full !== '1'); }
    catch { img.alt = 'фото не найдено'; img.classList.add('missing'); }
  });
}

// ----------------------------------------------------------------------
// Photo grid component (used in the point form and the trip dialog)
// ----------------------------------------------------------------------
class PhotoGrid {
  /** @param {HTMLElement} el  @param {{onExif?:Function, title?:Function}} opts */
  constructor(el, opts = {}) {
    this.el = el; this.ids = []; this.opts = opts; this.busy = 0;
    el.classList.add('pgrid');
    el.addEventListener('click', e => {
      const del = e.target.closest('[data-del]');
      if (del) { this.ids = this.ids.filter(x => x !== del.dataset.del); this.render(); return; }
      const th = e.target.closest('[data-open]');
      if (th) Lightbox.open(this.ids, this.ids.indexOf(th.dataset.open), this.opts.title?.());
      if (e.target.closest('.pg-add')) this.pick();
    });
    ['dragenter', 'dragover'].forEach(t => el.addEventListener(t, e => { e.preventDefault(); el.classList.add('drag'); }));
    ['dragleave', 'drop'].forEach(t => el.addEventListener(t, () => el.classList.remove('drag')));
    el.addEventListener('drop', e => { e.preventDefault(); this.addFiles([...e.dataTransfer.files]); });
    this.render();
  }
  set(ids) { this.ids = [...(ids || [])]; this.render(); }
  pick() {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.multiple = true; inp.accept = 'image/*,.heic,.heif';
    inp.onchange = () => this.addFiles([...inp.files]);
    inp.click();
  }
  async addFiles(files) {
    files = files.filter(f => /^image\//.test(f.type) || isHeic(f));
    if (!files.length) return;
    this.busy += files.length; this.render();
    let failed = 0, firstExif = null;
    for (const f of files) {
      try {
        const { id, exif } = await importPhotoFile(f);
        this.ids.push(id);
        if (!firstExif && (exif.lat != null || exif.date)) firstExif = exif;
      } catch (e) { console.warn(e); failed++; }
      this.busy--; this.render();
    }
    if (failed) toast('Не удалось добавить фото', `${failed} ${plural(failed, 'файл', 'файла', 'файлов')} не читается как изображение.`);
    if (firstExif && this.opts.onExif) this.opts.onExif(firstExif);
  }
  render() {
    this.el.innerHTML = this.ids.map(id => `
      <div class="pg-item"><img data-photo="${esc(id)}" data-open="${esc(id)}" alt="">
        <button type="button" class="pg-del" data-del="${esc(id)}" title="Убрать фото">×</button></div>`).join('')
      + (this.busy ? `<div class="pg-item pg-busy">обработка ${this.busy}…</div>` : '')
      + `<button type="button" class="pg-add" title="Добавить фото (можно перетащить файлы сюда)">${icon('camera', 20)}<span>Добавить</span></button>`;
    hydratePhotos(this.el);
  }
}

// ----------------------------------------------------------------------
// Lightbox
// ----------------------------------------------------------------------
const Lightbox = {
  el: null, ids: [], i: 0, title: '',
  open(ids, index = 0, title = '') {
    if (!ids.length) return;
    this.ids = ids; this.i = Math.max(0, index); this.title = title || '';
    if (!this.el) {
      this.el = document.createElement('div');
      this.el.className = 'lightbox';
      this.el.innerHTML = `<button class="lb-x" title="Закрыть (Esc)">${icon('x', 22)}</button><button class="lb-prev" title="Назад">${icon('chevronLeft', 24)}</button>
        <figure><img alt=""><figcaption></figcaption></figure><button class="lb-next" title="Вперёд">${icon('chevronRight', 24)}</button>`;
      document.body.appendChild(this.el);
      this.el.addEventListener('click', e => {
        if (e.target.closest('.lb-prev')) this.go(-1); else if (e.target.closest('.lb-next')) this.go(1);
        else if (e.target.closest('.lb-x') || e.target === this.el) this.close();
      });
      document.addEventListener('keydown', e => {
        if (!this.el.classList.contains('show')) return;
        if (e.key === 'Escape') { e.stopPropagation(); this.close(); } else if (e.key === 'ArrowLeft') this.go(-1); else if (e.key === 'ArrowRight') this.go(1);
      }, true);
    }
    this.el.classList.add('show');
    this.show();
  },
  async show() {
    const img = this.el.querySelector('img'), cap = this.el.querySelector('figcaption');
    const multi = this.ids.length > 1;
    this.el.querySelector('.lb-prev').hidden = !multi; this.el.querySelector('.lb-next').hidden = !multi;
    cap.textContent = [this.title, multi ? `${this.i + 1} из ${this.ids.length}` : ''].filter(Boolean).join(' · ');
    img.removeAttribute('src');
    try { img.src = await PhotoStore.url(this.ids[this.i], false); } catch { cap.textContent = 'Файл фото не найден'; }
  },
  go(d) { this.i = (this.i + d + this.ids.length) % this.ids.length; this.show(); },
  close() { this.el.classList.remove('show'); },
};
