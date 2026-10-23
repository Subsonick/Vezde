'use strict';
/* Update check: asks GitHub for the latest release and offers it in the sidebar.
   Updating means replacing Vezde.exe; the data lives separately (AppData\Vezde) and is upgraded on first start. */

const UPDATE_REPO = 'Subsonick/Vezde';
const RELEASES_URL = `https://github.com/${UPDATE_REPO}/releases/latest`;

/** Compares "2.10.1" style versions; returns >0 when a is newer. */
function cmpVersion(a, b) {
  const pa = String(a).replace(/^v/i, '').split(/[.-]/).map(n => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/i, '').split(/[.-]/).map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

const Updates = {
  latest: null,

  /** Latest release tag. Tries the browser first, then Windows' own curl / PowerShell,
      which go through the system proxy and certificates when the built-in browser can't. */
  async fetchLatest() {
    const api = `https://api.github.com/repos/${UPDATE_REPO}/releases/latest`;
    const tries = [
      async () => {
        const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 9000);
        try {
          const r = await fetch(api, { cache: 'no-store', signal: ctl.signal });
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return await r.json();
        } finally { clearTimeout(t); }
      },
    ];
    if (IS_NATIVE && /^win/i.test(window.NL_OS || '')) {
      const run = async cmd => {
        const r = await Neutralino.os.execCommand(cmd);
        if (r.exitCode !== 0) throw new Error('exit ' + r.exitCode);
        return r.stdOut || '';
      };
      tries.push(
        async () => JSON.parse(await run(`curl.exe -s -f -m 12 -A Vezde "${api}"`)),
        // no API at all: the releases/latest page redirects to …/tag/vX.Y.Z
        async () => {
          const out = await run(`curl.exe -s -I -m 12 -A Vezde "${RELEASES_URL}"`);
          const m = out.match(/\/releases\/tag\/([^\s/]+)/i);
          if (!m) throw new Error('no tag');
          return { tag_name: decodeURIComponent(m[1]), html_url: RELEASES_URL };
        },
        async () => {
          const ps = `[Net.ServicePointManager]::SecurityProtocol='Tls12'; (Invoke-RestMethod -UseBasicParsing -TimeoutSec 12 -Uri '${api}') | ConvertTo-Json -Compress`;
          return JSON.parse(await run(`powershell -NoProfile -NonInteractive -Command "${ps}"`));
        },
      );
    }
    let last;
    for (const t of tries) {
      try { const rel = await t(); if (rel && rel.tag_name) return rel; } catch (e) { last = e; }
    }
    throw last || new Error('no answer');
  },

  async check(manual) {
    let rel;
    try {
      rel = await this.fetchLatest();
    } catch (e) {
      console.warn('update check', e);
      if (manual) {
        const v = await modal({ icon: 'alert', title: 'Не удалось проверить обновления',
          text: 'Vezde не смогла связаться с GitHub. Проверьте интернет или откройте страницу загрузки в браузере: там всегда лежит последняя версия.',
          buttons: [{ label: 'Открыть страницу загрузки', value: 1, style: 'primary' }, { label: 'Закрыть', value: null, style: 'ghost' }] });
        if (v) this.openReleasePage();
      }
      return;
    }
    const ver = String(rel.tag_name || '').replace(/^v/i, '');
    if (!ver || cmpVersion(ver, APP_VERSION) <= 0) {
      if (manual) toast('У вас последняя версия', `Vezde ${APP_VERSION}`, 'ok');
      return;
    }
    this.latest = { version: ver, url: rel.html_url || RELEASES_URL, notes: String(rel.body || '') };
    if (!manual && S().updateDismissed === ver) return;
    this.showBanner();
    if (manual) this.howTo();
  },

  showBanner() {
    const u = this.latest; if (!u) return;
    let el = $('updateBanner');
    if (!el) {
      el = document.createElement('div');
      el.id = 'updateBanner'; el.className = 'update-banner';
      document.querySelector('.brand-meta').after(el);
    }
    el.innerHTML = `<span class="ub-ic">${icon('download', 17)}</span>
      <div class="ub-tx"><b>Вышла Vezde ${esc(u.version)}</b><span>У вас ${esc(APP_VERSION)}. Точки при обновлении сохранятся.</span></div>
      <button type="button" class="btn-solid ub-go">Обновить</button>
      <button type="button" class="mini-btn ub-x" title="Напомнить при следующей версии">${icon('x', 15)}</button>`;
    el.querySelector('.ub-go').onclick = () => this.howTo();
    el.querySelector('.ub-x').onclick = () => { setSetting('updateDismissed', u.version); el.remove(); };
  },

  async howTo() {
    const u = this.latest; if (!u) return;
    const notes = u.notes.split(/\r?\n/).map(l => l.replace(/^[-*#\s]+/, '').trim()).filter(Boolean).slice(0, 6);
    const { action } = await dialog({
      icon: 'download', title: `Обновление до Vezde ${u.version}`,
      html: `${notes.length ? `<div class="dlg-sub">Что нового</div><ul class="dlg-bullets">${notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
        <div class="dlg-sub">Как обновить</div>
        <ol class="dlg-bullets">
          <li>Нажмите «Открыть страницу загрузки» и скачайте <b>Vezde.exe</b>.</li>
          <li>Закройте Vezde.</li>
          <li>Положите новый Vezde.exe на место старого, с заменой.</li>
        </ol>
        <p class="hint">Точки, поездки и фото хранятся отдельно от программы, в папке AppData\\Vezde, и при замене файла не пропадут. Перед первым запуском новой версии сделается запасная копия.</p>`,
      buttons: [
        { label: 'Открыть страницу загрузки', value: 'open', style: 'primary' },
        { label: 'Позже', value: null, style: 'ghost' },
      ],
    });
    if (action === 'open') this.openReleasePage();
  },

  openReleasePage() {
    const url = this.latest?.url || RELEASES_URL;
    if (IS_NATIVE) Neutralino.os.open(url); else window.open(url, '_blank');
  },
};
