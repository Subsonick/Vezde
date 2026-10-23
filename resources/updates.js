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

/* Runs after Vezde has closed: swaps the exe for the downloaded one and starts it again.
   If the swap fails (file locked, no rights), the old version is kept and the download page opens. */
const UPDATE_PS = String.raw`param([string]$Exe, [string]$New, [int]$WaitPid = 0, [string]$Self, [string]$Page)
$ErrorActionPreference = 'Stop'
if ($WaitPid -gt 0) { try { Wait-Process -Id $WaitPid -Timeout 40 -ErrorAction SilentlyContinue } catch {} }
Start-Sleep -Milliseconds 800
$bak = $Exe + '.old'
$ok = $false
for ($i = 0; $i -lt 30 -and -not $ok; $i++) {
  try {
    if (Test-Path -LiteralPath $bak) { Remove-Item -LiteralPath $bak -Force }
    Move-Item -LiteralPath $Exe -Destination $bak -Force
    try { Move-Item -LiteralPath $New -Destination $Exe -Force; $ok = $true }
    catch { Move-Item -LiteralPath $bak -Destination $Exe -Force; throw }
  } catch { Start-Sleep -Milliseconds 700 }
}
if ($ok) {
  try { Remove-Item -LiteralPath $bak -Force } catch {}
  try { Unblock-File -LiteralPath $Exe } catch {}
} elseif ($Page) {
  try { Start-Process $Page } catch {}
}
try { Start-Process -FilePath $Exe -WorkingDirectory (Split-Path -Parent $Exe) } catch {}
if ($Self) { try { Remove-Item -LiteralPath $Self -Force } catch {} }
`;

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
    const exe = (rel.assets || []).find(a => /^vezde\.exe$/i.test(a.name || ''));
    this.latest = {
      version: ver, tag: rel.tag_name, url: rel.html_url || RELEASES_URL, notes: String(rel.body || ''),
      exeUrl: exe?.browser_download_url || `https://github.com/${UPDATE_REPO}/releases/download/${encodeURIComponent(rel.tag_name)}/Vezde.exe`,
      size: exe?.size || 0,
      sha256: /^sha256:([0-9a-f]{64})$/i.exec(exe?.digest || '')?.[1] || '',
    };
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

  canAutoUpdate() { return IS_NATIVE && /^win/i.test(window.NL_OS || ''); },

  async howTo() {
    const u = this.latest; if (!u) return;
    const auto = this.canAutoUpdate();
    const notes = u.notes.split(/\r?\n/).map(l => l.replace(/^[-*#\s]+/, '').trim()).filter(Boolean)
      .filter(l => !/^(как обновиться|если windows)/i.test(l.replace(/\*/g, ''))).slice(0, 6);
    const { action } = await dialog({
      icon: 'download', title: `Вышла Vezde ${u.version}`,
      html: `${notes.length ? `<div class="dlg-sub">Что нового</div><ul class="dlg-bullets">${notes.map(n => `<li>${esc(n.replace(/\*\*/g, ''))}</li>`).join('')}</ul>` : ''}
        ${auto
          ? `<p class="dlg-text">Нажмите «Обновить сейчас»: Vezde скачает новую версию, перезапустится и откроется уже обновлённой.</p>`
          : `<ol class="dlg-bullets"><li>Скачайте новый <b>Vezde.exe</b> на странице загрузки.</li><li>Закройте Vezde и замените им старый файл.</li></ol>`}
        <p class="hint">Точки, поездки и фото хранятся отдельно от программы и при обновлении не пропадут. Перед первым запуском новой версии сделается запасная копия.</p>`,
      buttons: [
        ...(auto ? [{ label: 'Обновить сейчас', value: 'auto', style: 'primary' }] : []),
        { label: auto ? 'Скачать вручную' : 'Открыть страницу загрузки', value: 'open', style: auto ? '' : 'primary' },
        { label: 'Позже', value: null, style: 'ghost' },
      ],
    });
    if (action === 'auto') this.install();
    else if (action === 'open') this.openReleasePage();
  },

  // ---- automatic update (Windows) ----
  async tempDir() {
    const temp = (await Neutralino.os.getPath('temp')).replace(/\//g, '\\').replace(/\\$/, '');
    const dir = `${temp}\\vezde-update`;
    try { await Neutralino.filesystem.createDirectory(dir); } catch {}
    return dir;
  },

  /** Removes what an earlier update left behind (downloaded exe, script). */
  async cleanup() {
    if (!this.canAutoUpdate()) return;
    try {
      const dir = (await Neutralino.os.getPath('temp')).replace(/\//g, '\\').replace(/\\$/, '') + '\\vezde-update';
      for (const e of await Neutralino.filesystem.readDirectory(dir)) {
        if (e.type === 'FILE') try { await Neutralino.filesystem.remove(`${dir}\\${e.entry}`); } catch {}
      }
    } catch {}
  },

  async exePath() {
    const cands = [];
    const a0 = String((window.NL_ARGS || [])[0] || '').replace(/\//g, '\\');
    if (/^[a-z]:\\.+\.exe$/i.test(a0)) cands.push(a0);
    const dir = Uninstaller.appDir();
    cands.push(`${dir}\\Vezde.exe`, `${dir}\\vezde-win_x64.exe`);
    for (const p of cands) { try { await Neutralino.filesystem.getStats(p); return p; } catch {} }
    throw new Error('Не найден файл программы');
  },

  progress(text) {
    let bg = document.getElementById('updProgress');
    if (!text) { bg?.remove(); return; }
    if (!bg) {
      bg = document.createElement('div');
      bg.id = 'updProgress'; bg.className = 'modal-bg show';
      bg.innerHTML = `<div class="modal upd-modal" role="dialog" aria-modal="true" aria-live="polite">
        <div class="mi">${icon('download', 22)}</div><div class="mt"></div>
        <div class="upd-bar"><i></i></div><div class="mx upd-tx"></div></div>`;
      document.body.appendChild(bg);
    }
    bg.querySelector('.mt').textContent = `Обновление до Vezde ${this.latest.version}`;
    bg.querySelector('.upd-tx').textContent = text;
  },

  async run(cmd) {
    const r = await Neutralino.os.execCommand(cmd);
    if (r.exitCode !== 0) throw new Error(`код ${r.exitCode}: ${(r.stdErr || '').trim().slice(0, 200)}`);
    return (r.stdOut || '').trim();
  },

  async download(file) {
    const u = this.latest;
    const tries = [
      () => this.run(`curl.exe -L -s -f --retry 2 -m 600 -A Vezde -o "${file}" "${u.exeUrl}"`),
      () => this.run(`powershell -NoProfile -NonInteractive -Command "[Net.ServicePointManager]::SecurityProtocol='Tls12'; $ProgressPreference='SilentlyContinue'; Invoke-WebRequest -UseBasicParsing -TimeoutSec 600 -Uri '${u.exeUrl}' -OutFile '${file.replace(/'/g, "''")}'"`),
    ];
    let last;
    for (const t of tries) {
      try { await Neutralino.filesystem.remove(file); } catch {}
      try { await t(); await this.verify(file); return; } catch (e) { last = e; console.warn('update download', e); }
    }
    throw last || new Error('не удалось скачать');
  },

  async verify(file) {
    const u = this.latest;
    const st = await Neutralino.filesystem.getStats(file);
    if (st.size < 1_000_000) throw new Error('файл скачался не полностью');
    if (u.size && st.size !== u.size) throw new Error(`размер ${st.size} вместо ${u.size}`);
    const head = new Uint8Array(await Neutralino.filesystem.readBinaryFile(file, { pos: 0, size: 2 }));
    if (head[0] !== 0x4d || head[1] !== 0x5a) throw new Error('это не программа Windows');
    if (u.sha256) {
      let h = '';
      try { h = await this.run(`powershell -NoProfile -NonInteractive -Command "(Get-FileHash -Algorithm SHA256 -LiteralPath '${file.replace(/'/g, "''")}').Hash"`); } catch {}
      if (h && h.toLowerCase() !== u.sha256.toLowerCase()) throw new Error('контрольная сумма не совпала');
    }
  },

  async install() {
    const u = this.latest; if (!u || this.installing) return;
    this.installing = true;
    try {
      await flushSave();
      this.progress('Скачиваю новую версию. Обычно это занимает меньше минуты…');
      const dir = await this.tempDir();
      const exe = await this.exePath();
      const file = `${dir}\\Vezde-${u.version.replace(/[^0-9a-z.\-]/gi, '')}.exe`;
      await this.download(file);
      this.progress('Готово. Vezde закроется и через пару секунд откроется уже новой версией.');
      const ps1 = `${dir}\\vezde-update-${Date.now()}.ps1`;
      await Neutralino.filesystem.writeFile(ps1, '\ufeff' + UPDATE_PS.replace(/\r?\n/g, '\r\n'));
      const q = s => s.replace(/"/g, '');
      const cmd = `powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${q(ps1)}" -Exe "${q(exe)}" -New "${q(file)}" -WaitPid ${window.NL_PID || 0} -Self "${q(ps1)}" -Page "${q(u.url)}"`;
      await Neutralino.os.execCommand(cmd, { background: true, cwd: dir });
      await new Promise(r => setTimeout(r, 1200));
      window.__vezdeUninstalling = true; // data is already saved; skip the save-on-close
      await Neutralino.app.exit();
    } catch (e) {
      console.error('auto update', e);
      this.progress(null);
      this.installing = false;
      const v = await modal({ icon: 'alert', title: 'Не получилось обновить автоматически',
        text: `Причина: ${e.message || e}.\nМожно обновить вручную: скачайте Vezde.exe на странице загрузки и замените им старый файл. Данные не пострадают.`,
        buttons: [{ label: 'Открыть страницу загрузки', value: 1, style: 'primary' }, { label: 'Закрыть', value: null, style: 'ghost' }] });
      if (v) this.openReleasePage();
    }
  },

  openReleasePage() {
    const url = this.latest?.url || RELEASES_URL;
    if (IS_NATIVE) Neutralino.os.open(url); else window.open(url, '_blank');
  },
};
