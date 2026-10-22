'use strict';
/* Full removal of Vezde from a Windows computer.
   One PowerShell script is the single source of truth. It is used two ways:
   1) the menu item "Удалить Vezde с компьютера" writes it to %TEMP% and runs it after the app exits;
   2) the app keeps a double-clickable "Удалить Vezde.cmd" next to Vezde.exe (works even if the app no longer starts).
   Safety rule: only files and folders with known names are deleted; the program folder itself is removed only when it is empty. */

const UNINSTALL_CMD_NAME = 'Удалить Vezde.cmd';

const UNINSTALL_PS = String.raw`
param([string]$Dir, [string]$Self = '', [switch]$Confirmed, [int]$WaitPid = 0)
$ErrorActionPreference = 'SilentlyContinue'
$nl = [Environment]::NewLine
Add-Type -AssemblyName System.Windows.Forms
[Environment]::CurrentDirectory = $env:TEMP
Set-Location -LiteralPath $env:TEMP
function Ask($text, $buttons = 'YesNo', $icon = 'Warning') { [System.Windows.Forms.MessageBox]::Show($text, 'Удаление Vezde', $buttons, $icon) }

$Dir = $Dir.TrimEnd('\')
if (-not $Dir -or -not (Test-Path -LiteralPath $Dir)) { Ask 'Не найдена папка программы.' 'OK' 'Error' | Out-Null; exit 1 }
$exeNames = @('Vezde.exe', 'TravelMap.exe', 'vezde-win_x64.exe', 'travel-map-win_x64.exe')
$exePaths = $exeNames | ForEach-Object { Join-Path $Dir $_ }
$dataDir = Join-Path $Dir 'data'
$ourData = (Test-Path -LiteralPath (Join-Path $dataDir 'travel-data.json')) -or (Test-Path -LiteralPath (Join-Path $dataDir 'backups')) -or (Test-Path -LiteralPath (Join-Path $dataDir 'photos'))
$appDataDir = Join-Path $env:APPDATA 'Vezde'
# where the points live now: AppData (2.1+) or next to the exe (older versions, portable mode)
$liveData = @($appDataDir, $dataDir) | Where-Object { Test-Path -LiteralPath (Join-Path $_ 'travel-data.json') } | Select-Object -First 1

if (-not $Confirmed) {
  $r = Ask ("Удалить Vezde с этого компьютера?$($nl)$($nl)Будут удалены программа, все точки, поездки, фото, запасные копии и настройки. Отменить это нельзя.$($nl)$($nl)Да — сначала сохранить копию данных на рабочий стол, потом удалить.$($nl)Нет — удалить без копии.$($nl)Отмена — ничего не делать.") 'YesNoCancel' 'Warning'
  if ($r -eq 'Cancel') { exit 0 }
  if ($r -eq 'Yes' -and $liveData) {
    $stamp = Get-Date -Format 'yyyy-MM-dd'
    $copy = Join-Path ([Environment]::GetFolderPath('Desktop')) "Vezde — копия данных $stamp"
    New-Item -ItemType Directory -Path $copy -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $liveData 'travel-data.json') -Destination $copy -Force
    if (Test-Path -LiteralPath (Join-Path $liveData 'photos')) { Copy-Item -LiteralPath (Join-Path $liveData 'photos') -Destination $copy -Recurse -Force }
    if (-not (Test-Path -LiteralPath (Join-Path $copy 'travel-data.json'))) { Ask 'Не удалось сохранить копию. Удаление отменено.' 'OK' 'Error' | Out-Null; exit 1 }
  }
}

# wait for the app (and its browser engine) to close
$deadline = (Get-Date).AddSeconds(20)
do {
  $running = Get-Process | Where-Object { ($WaitPid -gt 0 -and $_.Id -eq $WaitPid) -or ($_.Path -and $exePaths -contains $_.Path) }
  if (-not $running) { break }
  Start-Sleep -Milliseconds 500
} while ((Get-Date) -lt $deadline)
if ($running) {
  if ((Ask 'Vezde сейчас открыта. Закрыть её и продолжить удаление?' 'YesNo' 'Question') -ne 'Yes') { exit 0 }
  $running | Stop-Process -Force
  Start-Sleep -Seconds 1
}

function Remove-Safe($path, [switch]$Recurse) {
  for ($i = 0; $i -lt 12 -and (Test-Path -LiteralPath $path); $i++) {
    if ($Recurse) { Remove-Item -LiteralPath $path -Recurse -Force } else { Remove-Item -LiteralPath $path -Force }
    if (Test-Path -LiteralPath $path) { Start-Sleep -Milliseconds 700 }
  }
  -not (Test-Path -LiteralPath $path)
}
$failed = @()

# 1. browser engine profiles (cache, saved theme) in %APPDATA% and %LOCALAPPDATA%, named after the exe
foreach ($root in @($env:APPDATA, $env:LOCALAPPDATA)) {
  foreach ($n in ($exeNames + @('Vezde'))) {
    $p = Join-Path $root $n
    if ((Test-Path -LiteralPath $p) -and -not (Remove-Safe $p -Recurse)) { $failed += $p }
  }
}

# 2. program files with known names
if ($ourData -and -not (Remove-Safe $dataDir -Recurse)) { $failed += $dataDir }
$tmp = Join-Path $Dir '.tmp'
Remove-Safe (Join-Path $tmp 'window_state.config.json') | Out-Null
if ((Test-Path -LiteralPath $tmp) -and -not (Get-ChildItem -LiteralPath $tmp -Force)) { Remove-Item -LiteralPath $tmp -Force }
$storage = Join-Path $Dir '.storage'
if ((Test-Path -LiteralPath $storage) -and -not (Get-ChildItem -LiteralPath $storage -Force | Where-Object { $_.Extension -ne '.neustorage' })) { Remove-Safe $storage -Recurse | Out-Null }
$src = Join-Path $Dir 'source'
if ((Get-Content -LiteralPath (Join-Path $src 'neutralino.config.json') -Raw) -match 'ru\.travelmap\.diary') { Remove-Safe $src -Recurse | Out-Null }
foreach ($f in ($exeNames + @('neutralinojs.log', 'resources.neu', 'portable.txt', 'Как пользоваться.txt'))) {
  $p = Join-Path $Dir $f
  if ((Test-Path -LiteralPath $p) -and -not (Remove-Safe $p)) { $failed += $p }
}

# 3. shortcuts that point to this program
$shell = New-Object -ComObject WScript.Shell
$places = @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('CommonDesktopDirectory'), [Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('StartMenu'))
foreach ($pl in $places) {
  Get-ChildItem -LiteralPath $pl -Filter '*.lnk' -Recurse -Depth 1 | ForEach-Object {
    $t = $shell.CreateShortcut($_.FullName).TargetPath
    if ($t -and ($exeNames -contains (Split-Path $t -Leaf)) -and ((Split-Path $t -Parent) -eq $Dir)) { Remove-Item -LiteralPath $_.FullName -Force }
  }
}

# 4. Windows' own per-user records of the exe path (program name cache, compatibility assistant)
foreach ($key in @('HKCU:\Software\Classes\Local Settings\Software\Microsoft\Windows\Shell\MuiCache', 'HKCU:\Software\Microsoft\Windows NT\CurrentVersion\AppCompatFlags\Compatibility Assistant\Store')) {
  $item = Get-Item -LiteralPath $key
  if ($item) { $item.GetValueNames() | Where-Object { $v = $_; $exePaths | Where-Object { $v -like "$_*" } } | ForEach-Object { Remove-ItemProperty -LiteralPath $key -Name $_ -Force } }
}

# 5. this uninstaller and the folder itself (only if nothing else is left in it)
if ($Self -and (Test-Path -LiteralPath $Self)) { Remove-Item -LiteralPath $Self -Force }
$cmd = Join-Path $Dir 'Удалить Vezde.cmd'
if (Test-Path -LiteralPath $cmd) { Remove-Item -LiteralPath $cmd -Force }
# never remove a system or personal folder (if Vezde.exe was put straight on the Desktop, in Downloads, etc.)
$special = @('Desktop', 'CommonDesktopDirectory', 'MyDocuments', 'UserProfile', 'MyPictures', 'MyMusic', 'MyVideos', 'ProgramFiles', 'ProgramFilesX86', 'Windows', 'ApplicationData', 'LocalApplicationData') |
  ForEach-Object { [Environment]::GetFolderPath($_).TrimEnd('\') }
$special += (New-Object -ComObject Shell.Application).NameSpace('shell:Downloads').Self.Path
$isSpecial = ($special -contains $Dir) -or -not (Split-Path $Dir -Parent) -or ((Split-Path $Dir -Parent).TrimEnd('\') -eq (Split-Path $Dir -Qualifier))
$left = Get-ChildItem -LiteralPath $Dir -Force
if (-not $left -and -not $isSpecial) { Remove-Item -LiteralPath $Dir -Force }

if ($failed.Count) {
  Ask ("Vezde удалена не полностью. Не получилось удалить:$($nl)$($nl)" + ($failed -join "$($nl)") + "$($nl)$($nl)Перезагрузите компьютер и запустите удаление ещё раз или удалите эти папки вручную.") 'OK' 'Warning' | Out-Null
} elseif ($left) {
  Ask ("Vezde удалена.$($nl)$($nl)В папке остались ваши собственные файлы, их программа не трогала:$($nl)" + $Dir) 'OK' 'Information' | Out-Null
} else {
  Ask 'Vezde полностью удалена с компьютера.' 'OK' 'Information' | Out-Null
}
`;

/** Double-clickable launcher. The header is plain ASCII so cmd.exe can read it; the PowerShell part below is read back as UTF-8. */
function uninstallCmdText() {
  return [
    '@echo off',
    'set "VZ_SELF=%~f0"',
    'set "VZ_DIR=%~dp0"',
    'cd /d "%TEMP%"',
    'powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command "$t=[IO.File]::ReadAllText($env:VZ_SELF,[Text.Encoding]::UTF8); $m=\'#\'+\'VEZDE-PS\'; $c=$t.Substring($t.IndexOf($m)+$m.Length); & ([scriptblock]::Create($c)) -Dir $env:VZ_DIR -Self $env:VZ_SELF" & exit /b',
    '',
    '#VEZDE-PS' + UNINSTALL_PS,
  ].join('\r\n').replace(/\r?\n/g, '\r\n');
}

const Uninstaller = {
  appDir() { return (window.NL_PATH || '').replace(/\//g, '\\').replace(/\\$/, ''); },

  /** Keeps "Удалить Vezde.cmd" next to the program so removal works even if the app breaks. */
  async ensureFile() {
    if (!IS_NATIVE || !/^win/i.test(window.NL_OS || '')) return;
    const path = `${this.appDir()}\\${UNINSTALL_CMD_NAME}`;
    const text = uninstallCmdText();
    try { if (await Neutralino.filesystem.readFile(path) === text) return; } catch {}
    try { await Neutralino.filesystem.writeFile(path, text); } catch (e) { console.warn('uninstaller file', e); }
  },

  async start() {
    if (!IS_NATIVE || !/^win/i.test(window.NL_OS || '')) {
      await modal({ icon: 'info', title: 'Удаление доступно в программе для Windows', text: 'Здесь Vezde открыта в браузере. Чтобы убрать её данные, очистите данные сайта в настройках браузера.', buttons: [{ label: 'Понятно', value: 1, style: 'primary' }] });
      return;
    }
    const n = data.points.length, ph = referencedPhotoIds().size;
    const what = n ? `${n} ${plural(n, 'точка', 'точки', 'точек')}, ${data.trips.length} ${plural(data.trips.length, 'поездка', 'поездки', 'поездок')}${ph ? `, ${ph} фото` : ''}` : 'данных пока нет';
    const choice = await dialog({
      icon: 'trash', tone: 'danger', title: 'Удалить Vezde с компьютера?',
      html: `<p class="dlg-text">Будет удалено всё, что программа создала на этом компьютере:</p>
        <ul class="dlg-bullets">
          <li>сама программа;</li>
          <li>ваши точки, поездки и копии фото (${esc(what)}); исходные фото в ваших папках не трогаются;</li>
          <li>запасные копии, запомненные дороги и настройки;</li>
          <li>кэш карт и служебные файлы в папке AppData;</li>
          <li>ярлыки Vezde, если вы их создавали.</li>
        </ul>
        <p class="dlg-text">Отменить удаление нельзя. Если точки ещё пригодятся, сначала сохраните их в файл.</p>
        <label class="switch"><input type="checkbox" id="unConfirm"><span class="sw"></span>Я понимаю, что данные удалятся навсегда</label>`,
      buttons: [
        { label: 'Удалить всё', value: 'go', style: 'danger', validate: el => { const c = el.querySelector('#unConfirm'); if (c.checked) return true; const l = c.closest('.switch'); l.classList.remove('need'); void l.offsetWidth; l.classList.add('need'); toast('Подтвердите удаление', 'Включите переключатель «Я понимаю, что данные удалятся навсегда».', 'info'); return false; } },
        ...(n ? [{ label: 'Сначала сохранить копию', value: 'backup' }] : []),
        { label: 'Отмена', value: null, style: 'ghost' },
      ],
    });
    if (choice.action === 'backup') { await openShareDialog(); return; }
    if (choice.action !== 'go') return;

    try {
      const temp = (await Neutralino.os.getPath('temp')).replace(/\//g, '\\');
      const ps1 = `${temp}\\vezde-uninstall-${Date.now()}.ps1`;
      // BOM so Windows PowerShell 5 reads the Cyrillic text as UTF-8
      await Neutralino.filesystem.writeFile(ps1, '﻿' + UNINSTALL_PS.replace(/\r?\n/g, '\r\n'));
      const pid = window.NL_PID || 0;
      const cmd = `powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${ps1}" -Dir "${this.appDir()}" -Self "${ps1}" -Confirmed -WaitPid ${pid}`;
      await Neutralino.os.execCommand(cmd, { background: true, cwd: temp });
    } catch (e) {
      toast('Не удалось запустить удаление', `Закройте Vezde и запустите файл «${UNINSTALL_CMD_NAME}» в папке программы.`);
      return;
    }
    clearTimeout(saveTimer); saveTimer = null;     // nothing must be written after this point
    window.__vezdeUninstalling = true;
    await Neutralino.app.exit();
  },
};
