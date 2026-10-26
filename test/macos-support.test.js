const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const yaml = require('js-yaml');
const { assertNativeHost, artifactName, assertMachOArchitecture, verifyPublicConfig } = require('../scripts/mac-release.cjs');
const root = path.resolve(__dirname, '..');
const pkg = require('../package.json');
const config = yaml.load(fs.readFileSync(path.join(root, 'electron-builder.yml'), 'utf8'));
const website = pkg.name === 'truveil-recruiter' ? path.resolve(root, '../landing') : root;
const { validateMacManifest } = require(path.join(website, 'download-platform.js'));

test('Mac builds require a matching native Mac and cannot reuse Windows speech binaries', () => {
  for (const platform of ['win32', 'linux']) assert.throws(() => assertNativeHost({ platform, arch: 'x64' }), /on a Mac/);
  assert.equal(assertNativeHost({ platform: 'darwin', arch: 'arm64' }), 'arm64');
  assert.equal(assertNativeHost({ platform: 'darwin', arch: 'x64' }), 'x64');
  assert.throws(() => assertNativeHost({ platform: 'darwin', arch: 'arm64', requestedArch: 'x64' }), /matching architecture/);
  assert.throws(() => assertNativeHost({ platform: 'darwin', arch: 'x64', requestedArch: 'universal' }), /matching architecture/);
});

test('Mac artifact names separate apps and processor architectures', () => {
  for (const app of ['truveil-recruiter', 'truveil-secure']) {
    assert.notEqual(artifactName(app, '1.0.0', 'arm64'), artifactName(app, '1.0.0', 'x64'));
    assert.match(artifactName(app, '1.0.0', 'arm64'), /-mac-arm64\.dmg$/);
  }
  assert.throws(() => artifactName('unknown', '1.0.0', 'arm64'));
  assert.throws(() => artifactName(pkg.name, '../outside', 'arm64'));
});

test('native executable validation rejects Windows bytes and wrong-architecture Mach-O', () => {
  const header = Buffer.alloc(8);
  header.writeUInt32LE(0xfeedfacf, 0);
  header.writeUInt32LE(0x0100000c, 4);
  assert.doesNotThrow(() => assertMachOArchitecture(header, 'arm64'));
  assert.throws(() => assertMachOArchitecture(header, 'x64'), /does not match/);
  header.writeUInt32LE(0x01000007, 4);
  assert.doesNotThrow(() => assertMachOArchitecture(header, 'x64'));
  assert.throws(() => assertMachOArchitecture(Buffer.from('MZwindows'), 'x64'), /Mach-O/);
  assert.throws(() => assertMachOArchitecture(Buffer.alloc(2), 'x64'), /Mach-O/);
});

test('Mac bundling retains hardened runtime and minimal permissions', () => {
  require('@develar/schema-utils')(require('app-builder-lib/scheme.json'), config, { name: 'electron-builder' });
  assert.equal(config.mac.minimumSystemVersion, '12.0');
  assert.equal(config.mac.hardenedRuntime, true);
  const icon = fs.readFileSync(path.join(root, config.mac.icon));
  assert.equal(icon.toString('ascii', 0, 4), 'icns');
  assert.equal(icon.readUInt32BE(4), icon.length);
  assert.deepEqual(config.mac.target, ['dmg']);
  assert.match(config.mac.artifactName, /-mac-\$\{arch\}/);
  const entitlements = fs.readFileSync(path.join(root, config.mac.entitlements), 'utf8');
  assert.equal(config.mac.entitlementsInherit, config.mac.entitlements);
  assert.match(entitlements, /com\.apple\.security\.cs\.allow-jit/);
  assert.doesNotMatch(entitlements, /camera|screen|automation|apple-events|disable-library-validation/);
  if (pkg.name === 'truveil-secure') {
    assert.match(config.mac.extendInfo.NSMicrophoneUsageDescription, /consent/);
    assert.match(entitlements, /com\.apple\.security\.device\.audio-input/);
    assert.equal(config.extraResources[0].to, 'browser-extension');
  } else {
    assert.ok(config.asarUnpack.includes('node_modules/ffmpeg-static/ffmpeg'));
    assert.ok(config.asarUnpack.includes('node_modules/ffmpeg-static/ffmpeg.exe'));
    assert.doesNotMatch(entitlements, /audio-input/);
  }
  assert.match(config.win.artifactName, /-Setup-\$\{version\}\.\$\{ext\}/);
});

test('Mac windows reserve a native title bar without changing Windows caption scheduling', () => {
  const { mainHarness } = require('./helpers/main-harness');
  const h = mainHarness();
  for (const platform of ['darwin', 'win32']) {
    h.run(`process.platform = '${platform}'; createWindow();`);
    const options = h.windowOptions.at(-1);
    assert.equal(options.titleBarStyle, platform === 'darwin' ? 'default' : 'hiddenInset');
    assert.equal(options.webPreferences.backgroundThrottling, false);
    assert.equal(options.webPreferences.sandbox, true);
    assert.equal(options.webPreferences.contextIsolation, true);
  }
});

test('Mac runtime validation never accepts a privileged client key or provider secret', () => {
  const config = { supabaseUrl: 'https://example.invalid', supabaseAnonKey: 'sb_publishable_test' };
  assert.doesNotThrow(() => verifyPublicConfig(config));
  assert.throws(() => verifyPublicConfig({ ...config, deepgramApiKey: 'private' }), /Private/);
  assert.throws(() => verifyPublicConfig({ ...config, hostKey: 'private' }), /Private/);
  assert.throws(() => verifyPublicConfig({ ...config, hostAccessCode: 'private' }), /Private/);
  const key = 'header.' + Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url') + '.signature';
  assert.throws(() => verifyPublicConfig({ ...config, supabaseAnonKey: key }), /public Supabase/);
});

function manifest(arch = 'arm64') {
  return {
    schema: 2, app: pkg.name, version: pkg.version, platform: 'darwin', arch,
    installer: artifactName(pkg.name, pkg.version, arch), installerSha256: 'a'.repeat(64),
    sourceHash: 'b'.repeat(64), installerBytes: 12345,
    validated: { archive: true, signature: true, gatekeeper: true, notarization: true }
  };
}

test('Mac download links require the correct app, version, architecture and validated artifact', () => {
  assert.match(validateMacManifest(manifest(), pkg.name, pkg.version, 'arm64').href, /-mac-arm64\.dmg$/);
  const otherApp = pkg.name === 'truveil-recruiter' ? 'truveil-secure' : 'truveil-recruiter';
  for (const change of [
    { app: otherApp }, { version: '0.0.0' }, { arch: 'x64' }, { platform: 'win32' },
    { installer: 'https://untrusted.invalid/file.dmg' }, { installerSha256: 'unverified' },
    { sourceHash: null }, { installerBytes: 0 }, { validated: { archive: true, signature: true } }
  ]) assert.equal(validateMacManifest({ ...manifest(), ...change }, pkg.name, pkg.version, 'arm64'), null);
  assert.equal(validateMacManifest(null, pkg.name, pkg.version, 'arm64'), null);
  assert.equal(validateMacManifest(manifest(), pkg.name, pkg.version, 'universal'), null);
});

test('both platform options remain honest before a Mac artifact is published', () => {
  const html = fs.readFileSync(path.join(website, 'download.html'), 'utf8');
  assert.match(html, /name="download-platform" value="win32" checked/);
  assert.match(html, /name="download-platform" value="darwin"/);
  assert.match(html, /name="download-arch" value="arm64"/);
  assert.match(html, /name="download-arch" value="x64"/);
  assert.match(html, /id="mac-download-link" download hidden/);
  assert.doesNotMatch(html, /href="[^"]*\.dmg"/);
  assert.match(html, /Mac installer not published yet/);
});

test('Windows rejects Mac builds before changing runtime configuration', { skip: process.platform === 'darwin' }, () => {
  const file = path.join(root, 'src/config/runtime-config.json');
  const before = fs.readFileSync(file);
  const run = spawnSync(process.execPath, ['scripts/mac-release.cjs', '--build'], { cwd: root, encoding: 'utf8', windowsHide: true });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /on a Mac/);
  assert.deepEqual(fs.readFileSync(file), before);
});
