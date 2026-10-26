const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const recruiter = pkg.name === 'truveil-recruiter';
const filename = `${recruiter ? 'TruveilRecruiter' : 'TruveilSecure'}-Setup-${pkg.version}.exe`;
const downloads = recruiter ? path.resolve(root, '../landing/downloads') : path.join(root, 'downloads');
const manifestPath = path.join(downloads, 'release-manifest.json');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function sourceFiles() {
  const files = ['main.js', 'preload.js', 'package.json', 'package-lock.json', 'electron-builder.yml'];
  function walk(relative) {
    for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
      const name = `${relative}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error('Release inputs must not contain symbolic links.');
      if (entry.isDirectory()) walk(name);
      else if (entry.isFile()) files.push(name);
    }
  }
  walk('src');
  walk('assets');
  walk('browser-extension');
  return files.sort();
}

function sourceHash() {
  const hash = crypto.createHash('sha256');
  for (const file of sourceFiles()) hash.update(file + '\0').update(fs.readFileSync(path.join(root, file))).update('\0');
  return hash.digest('hex');
}

function verifyRelease() {
  if (!fs.existsSync(manifestPath)) throw new Error('Missing source-bound release manifest. Rebuild the Windows installer.');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.schema !== 1 || manifest.sourceHash !== sourceHash()) throw new Error('Windows installer is stale: its source differs from the current app.');
  if (manifest.installer !== filename || manifest.installerSha256 !== digest(fs.readFileSync(path.join(downloads, filename)))) {
    throw new Error('Windows installer does not match its release manifest.');
  }
  return manifest;
}

function verifyInstallerArchive(installer, expectedHash, extract) {
  const readArchive = extract || (() => execFileSync(require('7zip-bin').path7za,
    ['e', '-so', installer, 'resources\\app.asar'],
    { windowsHide: true, timeout: 120000, maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }));
  const archive = readArchive();
  if (!archive.length || digest(archive) !== expectedHash) {
    throw new Error('The archive embedded in the installer does not match the verified app.');
  }
}

function stageRelease() {
  const asar = require('@electron/asar');
  const archive = path.join(root, 'dist/win-unpacked/resources/app.asar');
  const installer = path.join(root, 'dist', filename);
  for (const file of sourceFiles().filter(file => /^(main\.js|preload\.js|src\/|assets\/|browser-extension\/protocol\.js$)/.test(file))) {
    const packed = asar.extractFile(archive, path.normalize(file));
    if (!packed.equals(fs.readFileSync(path.join(root, file)))) throw new Error(`Packaged file is missing or stale: ${file}`);
  }
  const packedConfig = JSON.parse(asar.extractFile(archive, path.normalize('src/config/runtime-config.json')).toString('utf8'));
  if (!packedConfig.supabaseUrl || !packedConfig.supabaseAnonKey) throw new Error('Packaged Supabase configuration is missing.');
  if (Object.keys(packedConfig).some(key => /service.role|secret|deepgram|groq|openai/i.test(key))) throw new Error('Private provider configuration must not be packaged.');
  const key = packedConfig.supabaseAnonKey;
  if (!key.startsWith('sb_publishable_')) {
    let payload;
    try { payload = JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString('utf8')); } catch {}
    if (payload?.role !== 'anon') throw new Error('Packaged Supabase key is not a public client key.');
  }
  verifyInstallerArchive(installer, digest(fs.readFileSync(archive)));
  for (const file of sourceFiles().filter(file => file.startsWith('browser-extension/'))) {
    const source = fs.readFileSync(path.join(root, file));
    const packed = fs.readFileSync(path.join(root, 'dist/win-unpacked/resources', file));
    const embedded = execFileSync(require('7zip-bin').path7za,
      ['e', '-so', installer, `resources\\${file.replaceAll('/', '\\')}`],
      { windowsHide: true, timeout: 120000, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    if (!source.equals(packed) || !source.equals(embedded)) throw new Error(`Packaged browser extension is missing or stale: ${file}`);
  }
  const manifest = {
    schema: 1, app: pkg.name, version: pkg.version, builtAt: new Date().toISOString(),
    installer: filename, installerSha256: digest(fs.readFileSync(installer)),
    archiveSha256: digest(fs.readFileSync(archive)), sourceHash: sourceHash()
  };
  fs.mkdirSync(downloads, { recursive: true });
  fs.copyFileSync(installer, path.join(downloads, filename));
  fs.writeFileSync(path.join(downloads, filename + '.sha256'), `${manifest.installerSha256}  ${filename}\n`);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  verifyRelease();
  console.log('Packaged sources verified; installer and release manifest staged.');
}

if (require.main === module) {
  try {
    if (process.argv.includes('--stage')) stageRelease();
    else { verifyRelease(); console.log('Source-bound installer verification passed.'); }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { sourceHash, verifyRelease, stageRelease, verifyInstallerArchive };
