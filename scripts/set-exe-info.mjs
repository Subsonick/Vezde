// Puts the Vezde icon and version info into the Windows exe built by `neu build`.
// Usage: node scripts/set-exe-info.mjs dist/vezde/vezde-win_x64.exe build/icon.ico
import * as ResEdit from 'resedit';
import * as PELibrary from 'pe-library';
import fs from 'fs';

const [,, exePath, icoPath = 'build/icon.ico'] = process.argv;
const config = JSON.parse(fs.readFileSync(new URL('../neutralino.config.json', import.meta.url), 'utf8'));
const [major, minor, patch] = config.version.split('.').map(Number);

const exe = PELibrary.NtExecutable.from(fs.readFileSync(exePath), { ignoreCert: true });
const res = PELibrary.NtExecutableResource.from(exe);
const ico = ResEdit.Data.IconFile.from(fs.readFileSync(icoPath));
const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
const gid = groups.length ? groups[0].id : 1;
const lang = groups.length ? groups[0].lang : 1033;
ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, gid, lang, ico.icons.map(i => i.data));

const vi = ResEdit.Resource.VersionInfo.fromEntries(res.entries);
if (vi.length) {
  const v = vi[0];
  v.setFileVersion(major, minor, patch, 0, 1033);
  v.setProductVersion(major, minor, patch, 0, 1033);
  v.setStringValues({ lang: 1033, codepage: 1200 }, {
    FileDescription: 'Vezde', ProductName: 'Vezde', ProductVersion: config.version, FileVersion: config.version,
    OriginalFilename: 'Vezde.exe', InternalName: 'vezde', LegalCopyright: 'Subsonick, MIT License',
  });
  v.outputToResourceEntries(res.entries);
}
res.outputResource(exe);
fs.writeFileSync(exePath, Buffer.from(exe.generate()));
console.log(`Vezde ${config.version}: icon and version info set`);
