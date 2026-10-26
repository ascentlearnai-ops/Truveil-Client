const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { sourceHash } = require('./release-artifact');

const root = path.resolve(__dirname, '..');
const pkg = require('../package.json');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function assertNativeHost({ platform = process.platform, arch = process.arch, requestedArch = arch } = {}) {
  if (platform !== 'darwin') throw new Error('Build and validate macOS installers on a Mac, not Windows.');
  if (!['arm64', 'x64'].includes(requestedArch) || requestedArch !== arch) {
    throw new Error('Build each Mac installer on its matching architecture so bundled speech binaries are correct.');
  }
  return requestedArch;
}

function artifactName(app, version, arch) {
  const product = { 'truveil-recruiter': 'TruveilRecruiter', 'truveil-secure': 'TruveilSecure' }[app];
  if (!product || !/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/i.test(version) || !['arm64', 'x64'].includes(arch)) {
    throw new Error('Invalid Mac release identity.');
  }
  return `${product}-${version}-mac-${arch}.dmg`;
}

function assertMachOArchitecture(header, arch) {
  if (!Buffer.isBuffer(header) || header.length < 8 || header.readUInt32LE(0) !== 0xfeedfacf) {
    throw new Error('Expected a native 64-bit Mach-O executable, not a Windows or universal binary.');
  }
  const cpu = { x64: 0x01000007, arm64: 0x0100000c }[arch];
  if (!cpu || header.readUInt32LE(4) !== cpu) throw new Error('Bundled executable architecture does not match this Mac installer.');
}

function checkBinary(file, arch) {
  const fd = fs.openSync(file, 'r');
  try {
    const header = Buffer.alloc(8);
    if (fs.readSync(fd, header, 0, header.length, 0) !== 8) throw new Error('Incomplete native executable.');
    assertMachOArchitecture(header, arch);
  } finally { fs.closeSync(fd); }
}

function command(executable, args, options = {}) {
  return execFileSync(executable, args, {
    cwd: root, timeout: 120000, maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'], ...options
  });
}

function build(arch) {
  assertNativeHost({ requestedArch: arch });
  command(process.execPath, ['scripts/sync-brand-assets.cjs', '--check'], { stdio: 'inherit' });
  // ffmpeg-static downloads a host-specific binary during npm ci.
  if (pkg.name === 'truveil-recruiter') checkBinary(require('ffmpeg-static'), arch);
  if (pkg.name === 'truveil-recruiter') command(process.execPath, ['scripts/build-provider-review.js'], { stdio: 'inherit' });
  command(process.execPath, ['scripts/write-runtime-config.js', '--production'], { stdio: 'inherit' });
  command(process.execPath, [require.resolve('electron-builder/out/cli/cli.js'),
    '--mac', 'dmg', '--' + arch, '--publish', 'never'], { timeout: 1800000, stdio: 'inherit' });
}

function verifyPublicConfig(config) {
  if (!config || typeof config.supabaseUrl !== 'string' || !config.supabaseUrl
    || typeof config.supabaseAnonKey !== 'string' || !config.supabaseAnonKey) throw new Error('Missing public runtime configuration.');
  const publicKeys = new Set(['supabaseUrl', 'supabaseAnonKey', 'demoRelayUrl', 'apiBaseUrl', 'candidateAppUrl']);
  if (Object.keys(config).some(key => !publicKeys.has(key))) {
    throw new Error('Private configuration must not be bundled.');
  }
  if (!config.supabaseAnonKey.startsWith('sb_publishable_')) {
    let payload;
    try { payload = JSON.parse(Buffer.from(config.supabaseAnonKey.split('.')[1], 'base64url').toString('utf8')); } catch {}
    if (payload?.role !== 'anon') throw new Error('Only a public Supabase client key may be bundled.');
  }
}

function verifyAppBundle(appPath, arch) {
  const asar = require('@electron/asar');
  const resources = path.join(appPath, 'Contents/Resources');
  const archive = path.join(resources, 'app.asar');
  const expected = ['main.js', 'preload.js'];
  function walk(relative) {
    for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error('Release inputs must not contain symbolic links.');
      const name = relative + '/' + entry.name;
      if (entry.isDirectory()) walk(name);
      else if (entry.isFile()) expected.push(name);
    }
  }
  walk('src');
  walk('assets');
  if (pkg.name === 'truveil-secure') expected.push('browser-extension/protocol.js');
  for (const file of expected) {
    if (!asar.extractFile(archive, file).equals(fs.readFileSync(path.join(root, file)))) {
      throw new Error('Packaged source is missing or stale: ' + file);
    }
  }
  const metadata = JSON.parse(asar.extractFile(archive, 'package.json').toString('utf8'));
  if (['name', 'version', 'main'].some(key => metadata[key] !== pkg[key])) throw new Error('Incorrect packaged app metadata.');
  const config = JSON.parse(asar.extractFile(archive, 'src/config/runtime-config.json').toString('utf8'));
  verifyPublicConfig(config);
  if (pkg.name === 'truveil-secure') {
    function verifyExtension(relative) {
      for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
        if (entry.isSymbolicLink()) throw new Error('Extension inputs must not contain symbolic links.');
        const file = relative + '/' + entry.name;
        if (entry.isDirectory()) verifyExtension(file);
        else if (entry.isFile() && !fs.readFileSync(path.join(root, file)).equals(fs.readFileSync(path.join(resources, file)))) {
          throw new Error('Packaged extension is missing or stale: ' + file);
        }
      }
    }
    verifyExtension('browser-extension');
  } else {
    checkBinary(path.join(resources, 'app.asar.unpacked/node_modules/ffmpeg-static/ffmpeg'), arch);
  }
  const plist = JSON.parse(command('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path.join(appPath, 'Contents/Info.plist')]));
  if (plist.CFBundleIdentifier !== (pkg.name === 'truveil-secure' ? 'com.truveil.secure' : 'com.truveil.recruiter')) {
    throw new Error('Incorrect bundle identity.');
  }
  if (pkg.name === 'truveil-secure' && !plist.NSMicrophoneUsageDescription) throw new Error('Missing microphone purpose notice.');
  checkBinary(path.join(appPath, 'Contents/MacOS', plist.CFBundleExecutable), arch);
  command('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath]);
  command('/usr/sbin/spctl', ['--assess', '--type', 'execute', appPath]);
  command('/usr/bin/xcrun', ['stapler', 'validate', appPath]);
  return digest(fs.readFileSync(archive));
}

function verify(arch) {
  assertNativeHost({ requestedArch: arch });
  const expectedSource = sourceHash();
  const filename = artifactName(pkg.name, pkg.version, arch);
  const installer = path.join(root, 'dist', filename);
  const expectedInstaller = digest(fs.readFileSync(installer));
  command('/usr/bin/hdiutil', ['verify', installer]);
  const mount = fs.mkdtempSync(path.join(os.tmpdir(), 'truveil-mac-verify-'));
  let mounted = false;
  try {
    command('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, installer]);
    mounted = true;
    const product = pkg.name === 'truveil-recruiter' ? 'Truveil' : 'TruveilSecure';
    const bundle = path.join(mount, product + '.app');
    if (!fs.existsSync(bundle)) throw new Error('The correct app was not found in the Mac installer.');
    const archiveSha256 = verifyAppBundle(bundle, arch);
    if (sourceHash() !== expectedSource) throw new Error('Source changed during validation. Rebuild before staging.');
    if (digest(fs.readFileSync(installer)) !== expectedInstaller) throw new Error('Installer changed during validation. Rebuild before staging.');
    return {
      schema: 2, app: pkg.name, version: pkg.version, platform: 'darwin', arch,
      builtAt: new Date().toISOString(), sourceHash: expectedSource,
      installer: filename, installerSha256: expectedInstaller,
      installerBytes: fs.statSync(installer).size, archiveSha256,
      validated: { archive: true, signature: true, gatekeeper: true, notarization: true }
    };
  } finally {
    if (mounted) command('/usr/bin/hdiutil', ['detach', mount]);
    fs.rmdirSync(mount);
  }
}

function stage(arch) {
  const manifest = verify(arch);
  const downloads = pkg.name === 'truveil-recruiter' ? path.resolve(root, '../landing/downloads') : path.join(root, 'downloads');
  fs.mkdirSync(downloads, { recursive: true });
  const destination = path.join(downloads, manifest.installer);
  const manifestPath = path.join(downloads, 'release-manifest-mac-' + arch + '.json');
  const temporary = destination + '.tmp-' + crypto.randomUUID();
  try {
    fs.copyFileSync(path.join(root, 'dist', manifest.installer), temporary);
    if (digest(fs.readFileSync(temporary)) !== manifest.installerSha256 || sourceHash() !== manifest.sourceHash) {
      throw new Error('Release inputs changed while staging. Do not publish this artifact.');
    }
    // A failed copy must not leave an old approval pointing at replacement bytes.
    fs.rmSync(manifestPath, { force: true });
    fs.renameSync(temporary, destination);
    fs.writeFileSync(destination + '.sha256', manifest.installerSha256 + '  ' + manifest.installer + '\n');
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  console.log('Verified Mac installer staged locally. No upload or publication was performed.');
}

if (require.main === module) {
  try {
    if (process.argv.includes('--all')) throw new Error('Build Windows on Windows with build:win, and macOS on a matching Mac with build:mac.');
    const index = process.argv.indexOf('--arch');
    if (index >= 0 && !['arm64', 'x64'].includes(process.argv[index + 1])) throw new Error('Choose --arch arm64 or --arch x64.');
    const arch = index < 0 ? process.arch : process.argv[index + 1];
    assertNativeHost({ requestedArch: arch });
    if (process.argv.includes('--check-host')) console.log('Native Mac build host verified.');
    else if (process.argv.includes('--build')) build(arch);
    else if (process.argv.includes('--stage')) stage(arch);
    else if (process.argv.includes('--verify')) { verify(arch); console.log('Mac installer/source/signing checks passed.'); }
    else throw new Error('Choose --build, --verify or --stage.');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { assertNativeHost, artifactName, assertMachOArchitecture, verifyPublicConfig };
