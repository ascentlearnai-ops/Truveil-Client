const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { check, inside } = require('../scripts/sync-brand-assets.cjs');
const root = path.resolve(__dirname, '..');
const recruiter = require('../package.json').name === 'truveil-recruiter';
const recruiterRoot = recruiter ? root : path.resolve(root, '../TrueVeils/recruiter-app');
const sourceAssets = path.resolve(recruiterRoot, '../landing/assets');
const canonical = fs.existsSync(path.join(sourceAssets, 'brand/mark.png')) ? sourceAssets : undefined;
const digest = value => crypto.createHash('sha256').update(value).digest('hex');

test('all local shared brand copies match their manifest and the canonical website when present', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'assets/brand-manifest.json'), 'utf8'));
  assert.equal(check(root, { sourceAssets: canonical }), manifest.files.length);
  assert.ok(manifest.files.some(file => file.path === 'assets/truveil.ico' && file.derived));
  assert.ok(manifest.files.some(file => file.path === 'assets/mac/icon.icns' && file.derived));
  const logo = recruiter ? 'assets/brand/mark.png' : 'src/renderer/assets/mark.png';
  assert.equal(digest(fs.readFileSync(path.join(root, logo))), manifest.logoSourceSha256);
  const windowsIcon = fs.readFileSync(path.join(root, 'assets/truveil.ico'));
  assert.equal(windowsIcon.readUInt16LE(0), 0);
  assert.equal(windowsIcon.readUInt16LE(2), 1);
  assert.ok(windowsIcon.readUInt16LE(4) > 0);
  const macIcon = fs.readFileSync(path.join(root, 'assets/mac/icon.icns'));
  assert.equal(macIcon.toString('ascii', 0, 4), 'icns');
});

test('app branding uses the website lock mark and never flattens its colors', () => {
  const html = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'src/renderer/styles.css'), 'utf8');
  assert.match(html, /class="app-brand"[\s\S]*?src="[^"]*\bmark\.png"/);
  assert.match(html, /rel="icon"[^>]*favicon\.png/);
  assert.doesNotMatch(html, /truveil-lock-transparent\.png/);
  for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (/\.app-brand\s+img|\.gb-brand-mark/.test(rule[1])) {
      assert.doesNotMatch(rule[2], /filter\s*:|opacity\s*:/);
    }
  }
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  assert.match(main, /icon:\s*path\.join\(__dirname, 'assets\/truveil\.ico'\)/);
});

test('start and platform builds check brand assets without silently replacing them', () => {
  const pkg = require('../package.json');
  assert.match(pkg.scripts.prestart, /sync-brand-assets\.cjs --check/);
  assert.match(pkg.scripts['prebuild:win'], /sync-brand-assets\.cjs --check/);
  const mac = fs.readFileSync(path.join(root, 'scripts/mac-release.cjs'), 'utf8');
  assert.match(mac, /\['scripts\/sync-brand-assets\.cjs', '--check'\]/);
  assert.doesNotMatch(pkg.scripts.prestart + pkg.scripts['prebuild:win'], /--sync/);
});

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'truveil-brand-test-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(base)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(base).startsWith('truveil-brand-test-'));
    fs.rmSync(base, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(base, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(base, 'assets/mark.png'), 'original mark');
  const manifest = { schema: 1, brand: 'truveil', logoSourceSha256: digest('original mark'), sourceInventoryHash: digest('inventory'),
    files: [{ path: 'assets/mark.png', source: 'brand/mark.png', sha256: digest('original mark') }] };
  const save = () => fs.writeFileSync(path.join(base, 'assets/brand-manifest.json'), JSON.stringify(manifest));
  save();
  return { base, manifest, save };
}

test('changed or missing assets fail rather than accepting stale copies', t => {
  const { base } = fixture(t);
  assert.equal(check(base), 1);
  fs.writeFileSync(path.join(base, 'assets/mark.png'), 'different logo');
  assert.throws(() => check(base), /Brand asset drift/);
  fs.rmSync(path.join(base, 'assets/mark.png'));
  assert.throws(() => check(base), /Brand asset drift/);
});

test('changed website masters are detected even when the local copy is internally consistent', t => {
  const { base } = fixture(t);
  const source = path.join(base, 'source');
  fs.mkdirSync(path.join(source, 'brand'), { recursive: true });
  fs.mkdirSync(path.join(source, 'fonts'), { recursive: true });
  fs.writeFileSync(path.join(source, 'brand/mark.png'), 'new approved master');
  assert.throws(() => check(base, { sourceAssets: source }), /Website brand source changed/);
});

test('brand manifest rejects duplicate entries and unsafe relative or absolute paths', t => {
  const { base, manifest, save } = fixture(t);
  manifest.files.push({ ...manifest.files[0] });
  save();
  assert.throws(() => check(base), /duplicate/);
  for (const file of ['../outside', '/outside', 'C:/outside', 'assets/../outside', 'assets\\outside', 'assets//mark.png']) {
    assert.throws(() => inside(base, file), /Invalid brand asset path|escapes/);
  }
});

test('canonical mark, mascot, fonts, media and website mirrors stay identical', { skip: !canonical }, () => {
  const website = path.resolve(recruiterRoot, '../landing');
  const candidate = path.resolve(recruiterRoot, '../../Truveil-Client');
  for (const directory of [website, candidate]) assert.ok(check(directory, { sourceAssets: canonical }) >= 26);
  assert.deepEqual(fs.readFileSync(path.join(recruiterRoot, 'assets/truveil.ico')), fs.readFileSync(path.join(candidate, 'assets/truveil.ico')));
  assert.deepEqual(fs.readFileSync(path.join(recruiterRoot, 'assets/mac/icon.icns')), fs.readFileSync(path.join(candidate, 'assets/mac/icon.icns')));
});

test('new canonical files require synchronization rather than silently going missing', t => {
  const { base, manifest, save } = fixture(t);
  const source = path.join(base, 'source');
  fs.mkdirSync(path.join(source, 'brand'), { recursive: true });
  fs.mkdirSync(path.join(source, 'fonts'), { recursive: true });
  fs.writeFileSync(path.join(source, 'brand/mark.png'), 'original mark');
  manifest.sourceInventoryHash = digest(JSON.stringify([{ source: 'brand/mark.png', sha256: digest('original mark') }]));
  save();
  assert.equal(check(base, { sourceAssets: source }), 1);
  fs.writeFileSync(path.join(source, 'brand/tavi-new.webp'), 'new mascot pose');
  assert.throws(() => check(base, { sourceAssets: source }), /Website brand source changed/);
});

test('a dangling symbolic link cannot redirect a synchronized asset outside the destination', t => {
  const { base } = fixture(t);
  const target = path.join(base, 'assets/dangling.png');
  assert.equal(fs.existsSync(target), false);
  const original = fs.lstatSync;
  try {
    fs.lstatSync = function (file, ...options) {
      if (file === target) return { isSymbolicLink: () => true };
      return original.call(this, file, ...options);
    };
    assert.throws(() => inside(base, 'assets/dangling.png'), /symbolic links/);
  } finally { fs.lstatSync = original; }
});
