'use strict';
/* Guided tour: highlights parts of the interface one by one and explains them. */

const TOUR_STEPS = [
  { title: 'Добро пожаловать в Vezde', text: 'Vezde хранит места, где вы побывали, и показывает их на карте. За минуту покажу, где что находится. Листайте кнопкой «Далее» или стрелками на клавиатуре, закрыть можно клавишей Esc.' },
  { tab: 'add', el: '.search-wrap', title: 'Поиск места', text: 'Начните вводить название или адрес, и снизу появятся варианты. Выберите нужный, тогда название, адрес и координаты заполнятся сами.' },
  { tab: 'add', el: () => $('fCoords').parentElement, title: 'Координаты', text: 'Если поиск не нашёл место, вставьте координаты прямо из Яндекс или Google Карт, например «55.932118, 40.898444». Или нажмите «На карте» и щёлкните нужное место. Метку потом можно перетащить.' },
  { tab: 'add', el: () => $('fDate').closest('.grid2'), title: 'Дата и регион', text: 'Дата посещения обязательна. Регион России определяется сам по координатам, но его можно выбрать вручную.' },
  { tab: 'add', el: () => $('fTrip').parentElement, title: 'Поездка', text: 'Точки объединяются в поездки. Выберите поездку из списка или создайте новую кнопкой «Новая». После сохранения поездка и дата остаются выбранными, так удобно вносить точки одной поездки подряд.' },
  { tab: 'add', el: '#fPhotos', title: 'Фото', text: 'Добавьте фото к месту кнопкой «Добавить» или перетащите файлы. Подходят и HEIC с iPhone. Если в фото есть геометка и дата, программа подставит их сама.' },
  { tab: 'add', el: '#saveBtn', title: 'Сохранить точку', text: 'Обязательные поля отмечены звёздочкой. Сохранить можно и сочетанием Ctrl+Enter.' },
  { tab: 'list', el: '#panel-list', title: 'Ваши точки', text: 'Здесь все точки, сгруппированные по поездкам и выстроенные по датам. Щелчок по точке или поездке показывает её на карте. Справа у поездки кнопки: поделиться, изменить название, комментарий и фото, удалить.' },
  { el: '.filterbar', title: 'Фильтры', text: 'Выберите галочками, какие поездки показывать, и год. Фильтр действует сразу на карту, список и статистику.' },
  { el: '#layersPanel', open: () => { $('layersPanel').hidden = false; }, close: () => { $('layersPanel').hidden = true; }, title: 'Вид карты', text: 'Кнопка со слоями справа вверху. По умолчанию открыта «Схема». «Под тему» подстраивает карту под тёмное или светлое оформление, есть ещё рельеф и спутник. Здесь же можно закрасить посещённые регионы и показать дороги маршрутов со стрелками.' },
  { el: '#legend', title: 'Точки на карте', text: 'Щёлкните по точке на карте, и откроется карточка с датой, адресом, заметкой и фото. Оттуда же точку можно изменить. Цвет точки совпадает с цветом поездки, подписи цветов внизу.' },
  { tab: 'stats', el: '#panel-stats', title: 'Статистика', text: 'Мини-карта России, где загораются посещённые регионы, пробег по поездкам, распределение по годам и ачивки.' },
  { el: '#themeBtn', title: 'Светлая и тёмная тема', text: 'Переключает оформление. Карта в режиме «Под тему» сменится вместе с ним.' },
  { el: '#menuBtn', title: 'Поделиться и запасные копии', text: 'Здесь можно сохранить в файл все поездки или только выбранные и отправить другу, загрузить чужой файл или запасную копию, открыть папку с данными. Здесь же можно полностью удалить Vezde с компьютера.' },
  { el: '#saveState', title: 'Автосохранение', text: 'Всё сохраняется само сразу после каждого изменения, в папку data рядом с программой. Раз в день делается запасная копия.' },
  { el: '#tourBtn', title: 'Вот и всё', text: 'Обучение всегда можно открыть снова этой кнопкой. Приятных поездок!' },
];

const Tour = {
  i: 0, root: null, prevTab: null,
  start() {
    this.prevTab = S().tab;
    this.i = 0;
    if (!this.root) this.build();
    this.root.hidden = false;
    document.addEventListener('keydown', this.onKey, true);
    window.addEventListener('resize', this.onResize);
    this.show();
  },
  build() {
    const r = document.createElement('div');
    r.className = 'tour'; r.hidden = true;
    r.innerHTML = `<div class="tour-spot"></div>
      <div class="tour-card" role="dialog" aria-live="polite">
        <div class="tour-progress"></div><div class="tour-title"></div><div class="tour-text"></div>
        <div class="tour-actions"><button type="button" class="tour-skip">Пропустить</button><span class="tour-count"></span>
          <button type="button" class="tour-back">Назад</button><button type="button" class="tour-next">Далее</button></div>
      </div>`;
    document.body.appendChild(r);
    r.querySelector('.tour-skip').onclick = () => this.end();
    r.querySelector('.tour-back').onclick = () => this.go(-1);
    r.querySelector('.tour-next').onclick = () => this.go(1);
    r.addEventListener('mousedown', e => { if (e.target === r || e.target.classList.contains('tour-spot')) e.preventDefault(); });
    this.root = r;
    this.onKey = e => {
      if (this.root.hidden) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.end(); }
      else if (e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); this.go(1); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); this.go(-1); }
    };
    this.onResize = () => this.place();
  },
  go(d) {
    const n = this.i + d;
    if (n >= TOUR_STEPS.length) return this.end(true);
    if (n < 0) return;
    this.i = n; this.show();
  },
  target() {
    const st = TOUR_STEPS[this.i];
    if (!st.el) return null;
    const el = typeof st.el === 'function' ? st.el() : document.querySelector(st.el);
    return el && el.offsetParent !== null ? el : null;
  },
  show() {
    const st = TOUR_STEPS[this.i];
    document.querySelectorAll('.popover, .menu, .suggest, .map-panel').forEach(x => x.hidden = true);
    if (st.tab) switchTab(st.tab);
    st.open?.();
    const card = this.root.querySelector('.tour-card');
    card.querySelector('.tour-count').textContent = `${this.i + 1} из ${TOUR_STEPS.length}`;
    card.querySelector('.tour-progress').innerHTML = TOUR_STEPS.map((_, k) => `<i class="${k <= this.i ? 'on' : ''}"></i>`).join('');
    card.querySelector('.tour-title').textContent = st.title;
    card.querySelector('.tour-text').textContent = st.text;
    card.querySelector('.tour-back').hidden = this.i === 0;
    card.querySelector('.tour-skip').hidden = this.i === TOUR_STEPS.length - 1;
    card.querySelector('.tour-next').textContent = this.i === TOUR_STEPS.length - 1 ? 'Готово' : this.i === 0 ? 'Начать' : 'Далее';
    const t = this.target();
    if (t) t.scrollIntoView({ block: 'nearest' });
    requestAnimationFrame(() => this.place());
    card.querySelector('.tour-next').focus();
  },
  place() {
    if (!this.root || this.root.hidden) return;
    const st = TOUR_STEPS[this.i];
    const spot = this.root.querySelector('.tour-spot'), card = this.root.querySelector('.tour-card');
    const t = this.target();
    const W = innerWidth, H = innerHeight, cw = card.offsetWidth, ch = card.offsetHeight, gap = 14;
    if (!t) {
      spot.style.cssText = `left:${W / 2}px;top:${H / 2}px;width:0;height:0;`;
      card.style.left = `${(W - cw) / 2}px`; card.style.top = `${(H - ch) / 2}px`;
      return;
    }
    const pad = st.pad ?? 6;
    let r = t.getBoundingClientRect();
    const x = Math.max(4, r.left - pad), y = Math.max(4, r.top - pad);
    const w = Math.min(W - 8, r.right + pad) - x, h = Math.min(H - 8, r.bottom + pad) - y;
    spot.style.cssText = `left:${x}px;top:${y}px;width:${w}px;height:${h}px;`;
    // card: try right, left, below, above, then centre
    const fits = (cx, cy) => cx >= 8 && cy >= 8 && cx + cw <= W - 8 && cy + ch <= H - 8;
    const clampY = v => Math.min(Math.max(8, v), H - ch - 8), clampX = v => Math.min(Math.max(8, v), W - cw - 8);
    const opts = [
      [x + w + gap, clampY(y)], [x - cw - gap, clampY(y)],
      [clampX(x), y + h + gap], [clampX(x), y - ch - gap],
    ];
    const pos = opts.find(([cx, cy]) => fits(cx, cy)) || [(W - cw) / 2, H - ch - 24];
    card.style.left = `${pos[0]}px`; card.style.top = `${pos[1]}px`;
  },
  end(done) {
    this.root.hidden = true;
    TOUR_STEPS[this.i]?.close?.();
    document.removeEventListener('keydown', this.onKey, true);
    window.removeEventListener('resize', this.onResize);
    if (this.prevTab) switchTab(this.prevTab);
    if (!S().tourDone) { setSetting('tourDone', true); if (!done) toast('Обучение можно открыть снова', 'Кнопкой со знаком вопроса вверху панели.', 'info'); }
  },
};
