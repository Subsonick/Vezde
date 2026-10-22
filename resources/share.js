'use strict';
/* Sharing: export all or selected trips to a single file (optionally with notes and photos), and import such files. */

/** Modal with custom HTML body. Resolves {action, el} — el is still in the DOM until the promise settles. */
function dialog({ icon: ic = '', tone = '', title, html = '', buttons, onInit }) {
  return new Promise(resolve => {
    const bg = document.createElement('div');
    bg.className = 'modal-bg';
    bg.innerHTML = `<div class="modal modal-wide" role="dialog" aria-modal="true">
      ${ic ? `<div class="mi ${tone}">${icon(ic, 22)}</div>` : ''}<div class="mt">${esc(title)}</div>
      <div class="mbody">${html}</div>
      <div class="ma row-actions">${buttons.map((b, i) => `<button type="button" data-i="${i}" class="${b.style || ''}">${esc(b.label)}</button>`).join('')}</div></div>`;
    document.body.appendChild(bg);
    requestAnimationFrame(() => bg.classList.add('show'));
    const finish = action => {
      document.removeEventListener('keydown', onKey);
      resolve({ action, el: bg });
      bg.classList.remove('show'); setTimeout(() => bg.remove(), 180);
    };
    const onKey = e => { if (e.key === 'Escape' && !document.querySelector('.lightbox.show')) finish(null); };
    document.addEventListener('keydown', onKey);
    bg.addEventListener('mousedown', e => { if (e.target === bg) finish(null); });
    bg.querySelectorAll('.ma button').forEach(b => b.addEventListener('click', () => {
      const btn = buttons[b.dataset.i];
      if (btn.validate && !btn.validate(bg)) return;
      finish(btn.value);
    }));
    onInit?.(bg);
  });
}

function tripCheckList(items, checkedSet) {
  return `<div class="dlg-list">${items.map(it => `
    <label class="check-row"><input type="checkbox" data-k="${esc(it.key)}" ${checkedSet.has(it.key) ? 'checked' : ''}>
      <span class="dot" style="background:${it.color}"></span><span class="name">${esc(it.name)}</span>
      <span class="cnt">${it.count} ${plural(it.count, 'точка', 'точки', 'точек')}${it.photos ? ` · ${it.photos} фото` : ''}</span></label>`).join('')}</div>`;
}
const checkedKeys = el => new Set([...el.querySelectorAll('.dlg-list input:checked')].map(i => i.dataset.k));
const safeFileName = s => s.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'маршрут';

// ----------------------------------------------------------------------
// Export
// ----------------------------------------------------------------------
async function openShareDialog(preselect = null) {
  if (!data.points.length && !data.trips.length) { toast('Нечего сохранять', 'Сначала добавьте хотя бы одну точку.', 'info'); return; }
  const keys = allTripKeys();
  const items = keys.map(k => {
    const pts = data.points.filter(p => p.tripId === k);
    const photos = pts.reduce((s, p) => s + (p.photos?.length || 0), 0) + (k ? (tripById(k)?.photos?.length || 0) : 0);
    return { key: k, name: tripName(k), color: tripColor(k), count: pts.length, photos };
  });
  const pre = new Set(preselect ? preselect : keys);
  const totalPhotos = items.reduce((s, i) => s + i.photos, 0);

  const { action, el } = await dialog({
    icon: 'share', title: preselect && preselect.length === 1 ? `Поделиться поездкой «${tripName(preselect[0])}»` : 'Поделиться или сохранить в файл',
    html: `
      <p class="dlg-text">Получится один файл. Отправьте его другу, и он откроет его у себя через меню <b>Загрузить из файла</b>.</p>
      <div class="dlg-sub">Что включить</div>
      <div class="popover-actions"><button type="button" data-all>Выбрать все</button><button type="button" data-none>Снять все</button></div>
      ${tripCheckList(items, pre)}
      <div class="dlg-sub">Дополнительно</div>
      <label class="switch"><input type="checkbox" id="exNotes" checked><span class="sw"></span>Заметки к точкам и комментарии к поездкам</label>
      <label class="switch"><input type="checkbox" id="exPhotos" ${totalPhotos ? 'checked' : 'disabled'}><span class="sw"></span>Фото&nbsp;<span class="hint" id="exSize" style="margin:0"></span></label>
      <div class="dlg-summary" id="exSummary"></div>`,
    buttons: [
      { label: 'Сохранить файл', value: 'save', style: 'primary', validate: el => checkedKeys(el).size > 0 || (toast('Ничего не выбрано', 'Отметьте хотя бы одну поездку.'), false) },
      { label: 'Отмена', value: null, style: 'ghost' },
    ],
    onInit: el => {
      const upd = () => {
        const sel = checkedKeys(el);
        const chosen = items.filter(i => sel.has(i.key));
        const n = chosen.reduce((s, i) => s + i.count, 0), ph = chosen.reduce((s, i) => s + i.photos, 0);
        const withPhotos = el.querySelector('#exPhotos').checked;
        const mb = withPhotos ? ph * 0.62 : 0;
        el.querySelector('#exSize').textContent = ph ? `(${ph} шт.)` : totalPhotos ? '(в выбранных поездках нет фото)' : '(фото пока не добавлены)';
        el.querySelector('#exSummary').textContent = `В файле: ${chosen.length} ${plural(chosen.length, 'поездка', 'поездки', 'поездок')}, ${n} ${plural(n, 'точка', 'точки', 'точек')}`
          + (withPhotos && ph ? `, ${ph} фото. Размер около ${mb < 1 ? '1' : Math.round(mb)} МБ` : '');
      };
      el.querySelector('[data-all]').onclick = () => { el.querySelectorAll('.dlg-list input').forEach(i => i.checked = true); upd(); };
      el.querySelector('[data-none]').onclick = () => { el.querySelectorAll('.dlg-list input').forEach(i => i.checked = false); upd(); };
      el.addEventListener('change', upd); upd();
    },
  });
  if (action !== 'save') return;
  const sel = checkedKeys(el);
  const withNotes = el.querySelector('#exNotes').checked, withPhotos = el.querySelector('#exPhotos').checked;

  const trips = data.trips.filter(t => sel.has(t.id)).map(t => ({ id: t.id, name: t.name, color: t.color,
    comment: withNotes ? (t.comment || '') : '', photos: withPhotos ? [...(t.photos || [])] : [] }));
  const points = data.points.filter(p => sel.has(p.tripId)).map(p => ({ ...p, note: withNotes ? p.note : '', photos: withPhotos ? [...(p.photos || [])] : [] }));
  const photos = {};
  if (withPhotos) {
    const ids = [...trips.flatMap(t => t.photos), ...points.flatMap(p => p.photos)];
    if (ids.length > 5) toast('Собираю фото…', `${ids.length} шт.`, 'info');
    for (const id of ids) {
      try { photos[id] = [await PhotoStore.dataURL(id, false), await PhotoStore.dataURL(id, true)]; }
      catch { /* missing file: skip */ }
    }
    points.forEach(p => p.photos = p.photos.filter(id => photos[id]));
    trips.forEach(t => t.photos = t.photos.filter(id => photos[id]));
  }
  const all = sel.size === keys.length;
  const name = all ? `vezde-${todayISO()}.json`
    : trips.length === 1 && !sel.has(NO_TRIP) ? `маршрут-${safeFileName(trips[0].name)}.json` : `маршруты-${todayISO()}.json`;
  try {
    const path = await Store.exportFile({ app: 'travel-map', version: 3, exportedAt: new Date().toISOString(), trips, points, photos }, name);
    if (path) toast('Файл сохранён', path.split(/[\\/]/).pop(), 'ok');
  } catch (e) { toast('Не удалось сохранить файл', String(e.message || e)); }
}

// ----------------------------------------------------------------------
// Import
// ----------------------------------------------------------------------
async function openImportDialog() {
  let text;
  try { text = await Store.importFile(); } catch (e) { toast('Не удалось открыть файл', String(e.message || e)); return; }
  if (text == null) return;
  let raw, incoming;
  try {
    raw = JSON.parse(text);
    if (!Array.isArray(raw.points) || !Array.isArray(raw.trips)) throw 0;
    incoming = normalizeData(raw);
  } catch {
    await modal({ icon: 'alert', tone: 'danger', title: 'Этот файл не подходит', text: 'В нём нет точек и поездок, сохранённых в Vezde.', buttons: [{ label: 'Понятно', value: 1, style: 'primary' }] });
    return;
  }
  const filePhotos = raw.photos && typeof raw.photos === 'object' ? raw.photos : {};
  const iTrip = id => incoming.trips.find(t => t.id === id);
  const keys = [...incoming.trips.map(t => t.id), ...(incoming.points.some(p => !p.tripId) ? [NO_TRIP] : [])];
  const items = keys.map(k => {
    const pts = incoming.points.filter(p => p.tripId === k);
    const photos = pts.reduce((s, p) => s + p.photos.filter(id => filePhotos[id]).length, 0) + (k ? iTrip(k).photos.filter(id => filePhotos[id]).length : 0);
    const exists = k && tripById(k);
    return { key: k, name: (k ? iTrip(k).name : 'Без поездки') + (exists ? ' (уже есть, добавятся только новые точки)' : ''), color: k ? iTrip(k).color : NO_TRIP_COLOR, count: pts.length, photos };
  });
  const when = raw.exportedAt ? new Date(raw.exportedAt).toLocaleDateString('ru-RU') : '';

  const { action, el } = await dialog({
    icon: 'download', title: 'Загрузка из файла',
    html: `<p class="dlg-text">${when ? `Файл от ${esc(when)}. ` : ''}Выберите, какие поездки загрузить.</p>
      <div class="popover-actions"><button type="button" data-all>Выбрать все</button><button type="button" data-none>Снять все</button></div>
      ${tripCheckList(items, new Set(keys))}
      <p class="hint">Кнопка «Добавить» ничего не удаляет: ваши точки останутся, повторы пропустятся.</p>`,
    buttons: [
      { label: 'Добавить к моим точкам', value: 'merge', style: 'primary', validate: el => checkedKeys(el).size > 0 || (toast('Ничего не выбрано', 'Отметьте хотя бы одну поездку.'), false) },
      { label: 'Заменить все мои данные', value: 'replace', style: 'danger', validate: el => checkedKeys(el).size > 0 || (toast('Ничего не выбрано', 'Отметьте хотя бы одну поездку.'), false) },
      { label: 'Отмена', value: null, style: 'ghost' },
    ],
    onInit: el => {
      el.querySelector('[data-all]').onclick = () => el.querySelectorAll('.dlg-list input').forEach(i => i.checked = true);
      el.querySelector('[data-none]').onclick = () => el.querySelectorAll('.dlg-list input').forEach(i => i.checked = false);
    },
  });
  if (!action) return;
  const sel = checkedKeys(el);

  if (action === 'replace') {
    const ok = await modal({ icon: 'alert', tone: 'danger', title: 'Заменить все ваши данные?', text: `Сейчас у вас ${data.points.length} ${plural(data.points.length, 'точка', 'точки', 'точек')}. Они будут заменены содержимым файла.\nКопия текущих данных сохранится в папке data\\backups.`,
      buttons: [{ label: 'Заменить', value: true, style: 'danger' }, { label: 'Отмена', value: null, style: 'ghost' }] });
    if (!ok) return;
    await Store.dailyBackup(data, true);
  }

  // write photos from the file
  const existingPhotos = new Set(await PhotoStore.listIds());
  const needed = new Set();
  incoming.points.filter(p => sel.has(p.tripId)).forEach(p => p.photos.forEach(id => needed.add(id)));
  incoming.trips.filter(t => sel.has(t.id)).forEach(t => t.photos.forEach(id => needed.add(id)));
  const available = new Set();
  let wrote = 0;
  if (needed.size > 5) toast('Загружаю фото…', `${needed.size} шт.`, 'info');
  for (const id of needed) {
    if (existingPhotos.has(id)) { available.add(id); continue; }
    const pair = filePhotos[id];
    if (!Array.isArray(pair) || !pair[0]) continue;
    try { await PhotoStore.putDataURL(id, pair[0], pair[1]); available.add(id); wrote++; } catch (e) { console.warn(e); }
  }
  const fixPhotos = arr => (arr || []).filter(id => available.has(id));

  let added = 0, tripsAdded = 0;
  if (action === 'replace') {
    data.trips = incoming.trips.filter(t => sel.has(t.id)).map(t => ({ ...t, photos: fixPhotos(t.photos) }));
    data.points = incoming.points.filter(p => sel.has(p.tripId)).map(p => ({ ...p, photos: fixPhotos(p.photos) }));
    added = data.points.length; tripsAdded = data.trips.length;
  } else {
    incoming.trips.filter(t => sel.has(t.id)).forEach(t => {
      const mine = tripById(t.id);
      if (mine) {
        if (!mine.comment && t.comment) mine.comment = t.comment;
        mine.photos = [...new Set([...(mine.photos || []), ...fixPhotos(t.photos)])];
      } else {
        if (data.trips.some(x => x.color === t.color)) t.color = nextTripColor();
        data.trips.push({ ...t, photos: fixPhotos(t.photos) }); tripsAdded++;
      }
    });
    const sig = p => `${p.lat.toFixed(5)}|${p.lon.toFixed(5)}|${p.date}|${p.name.toLowerCase()}`;
    const ids = new Set(data.points.map(p => p.id)), sigs = new Set(data.points.map(sig));
    incoming.points.filter(p => sel.has(p.tripId)).forEach(p => {
      if (ids.has(p.id) || sigs.has(sig(p))) return;
      data.points.push({ ...p, photos: fixPhotos(p.photos) }); added++;
    });
  }
  S().selectedTrips = null; S().year = 'all';
  persist(); endEdit(); refreshAll(true);
  if (action === 'replace' && !readOnly) cleanupPhotos();
  toast(action === 'replace' ? 'Данные заменены' : 'Загружено',
    `${added} ${plural(added, 'новая точка', 'новые точки', 'новых точек')}${tripsAdded ? `, ${tripsAdded} ${plural(tripsAdded, 'поездка', 'поездки', 'поездок')}` : ''}${wrote ? `, ${wrote} фото` : ''}`, 'ok');
}
