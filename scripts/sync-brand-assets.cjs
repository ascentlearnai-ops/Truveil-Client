const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const digest = data => crypto.createHash('sha256').update(data).digest('hex');

function inside(directory, relative) {
  if (typeof relative !== 'string' || !relative || relative.includes('\\')
    || relative.includes('\0') || path.posix.isAbsolute(relative) || path.win32.isAbsolute(relative)
    || relative.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Invalid brand asset path.');
  const target = path.resolve(directory, relative);
  if (!target.startsWith(path.resolve(directory) + path.sep)) throw new Error('Brand asset escapes its root.');
  let current = path.resolve(directory);
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Brand assets must not use symbolic links.');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return target;
}

function readManifest(directory) {
  const manifest = JSON.parse(fs.readFileSync(inside(directory, 'assets/brand-manifest.json'), 'utf8'));
  if (manifest.schema !== 1 || manifest.brand !== 'truveil' || !/^[a-f0-9]{64}$/.test(manifest.logoSourceSha256)
    || !/^[a-f0-9]{64}$/.test(manifest.sourceInventoryHash)
    || !Array.isArray(manifest.files) || !manifest.files.length) throw new Error('Invalid brand manifest.');
  return manifest;
}

function sourceInventory(sourceAssets) {
  const files = [];
  for (const directory of ['brand', 'fonts']) {
    for (const entry of fs.readdirSync(path.join(sourceAssets, directory), { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('Unexpected entry in the shared brand source.');
      if (!/\.(?:png|webp|mp4|ttf|txt)$/.test(entry.name)) throw new Error('Unsupported shared brand asset.');
      const source = directory + '/' + entry.name;
      files.push({ source, sha256: digest(fs.readFileSync(inside(sourceAssets, source))) });
    }
  }
  return files;
}

function check(directory, { sourceAssets } = {}) {
  const manifest = readManifest(directory);
  if (sourceAssets && digest(JSON.stringify(sourceInventory(sourceAssets))) !== manifest.sourceInventoryHash) {
    throw new Error('Website brand source changed. Run brand:sync before building.');
  }
  const seen = new Set();
  for (const file of manifest.files) {
    if (!file || seen.has(file.path) || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('Invalid or duplicate brand asset entry.');
    seen.add(file.path);
    const local = inside(directory, file.path);
    if (!fs.existsSync(local) || digest(fs.readFileSync(local)) !== file.sha256) throw new Error('Brand asset drift: ' + file.path);
    if (sourceAssets && file.source) {
      if (digest(fs.readFileSync(inside(sourceAssets, file.source))) !== (file.derived ? manifest.logoSourceSha256 : file.sha256)) {
        throw new Error('Website brand source changed: ' + file.source + '. Run brand:sync before building.');
      }
    }
  }
  return manifest.files.length;
}

function copyFile(source, directory, relative) {
  const destination = inside(directory, relative);
  const data = fs.readFileSync(source);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  if (!fs.existsSync(destination) || !fs.readFileSync(destination).equals(data)) fs.writeFileSync(destination, data);
  return { path: relative, sha256: digest(data) };
}

function renderIcons(source, destination) {
  const electron = require('electron');
  electron.app.whenReady().then(() => {
    const image = electron.nativeImage.createFromPath(source);
    const size = image.getSize();
    if (image.isEmpty() || size.width !== size.height) throw new Error('The website mark must be a readable square image.');
    fs.writeFileSync(destination, image.resize({ width: 1024, height: 1024, quality: 'best' }).toPNG());
    electron.app.exit(0);
  }).catch(error => { console.error(error.message); electron.app.exit(1); });
}

function generateIcons(source) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'truveil-brand-'));
  try {
    const png = path.join(temporary, 'app-icon.png');
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    execFileSync(require('electron'), [__filename, '--render-icons', source, png], {
      env, windowsHide: true, timeout: 30000, stdio: ['ignore', 'pipe', 'pipe']
    });
    const builder = require('app-builder-bin').appBuilderPath;
    const outputs = { png };
    for (const format of ['ico', 'icns']) {
      const output = path.join(temporary, format);
      const result = JSON.parse(execFileSync(builder, ['icon', '--format', format, '--root', temporary,
        '--input', png, '--out', output], { windowsHide: true, timeout: 30000, encoding: 'utf8' }));
      if (result.error || result.isFallback || !result.icons?.length) throw new Error('Brand icon conversion failed for ' + format + '.');
      outputs[format] = result.icons[0].file;
    }
    return Object.fromEntries(Object.entries(outputs).map(([key, file]) => [key, fs.readFileSync(file)]));
  } finally {
    const resolved = path.resolve(temporary);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('truveil-brand-')) {
      throw new Error('Refusing cleanup outside the temporary brand directory.');
    }
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}

function synchronize({ recruiterRoot, clientRoot }) {
  if (require(path.join(recruiterRoot, 'package.json')).name !== 'truveil-recruiter'
    || require(path.join(clientRoot, 'package.json')).name !== 'truveil-secure') throw new Error('Expected the two Truveil app repositories.');
  const website = path.resolve(recruiterRoot, '../landing');
  const sourceAssets = path.join(website, 'assets');
  const inventory = sourceInventory(sourceAssets);
  const websiteFiles = inventory.map(file => file.source);
  const logo = inside(sourceAssets, 'brand/mark.png');
  const logoSourceSha256 = digest(fs.readFileSync(logo));
  const manifests = new Map([website, recruiterRoot, clientRoot].map(directory => [directory, new Map()]));
  function add(directory, source, destination) {
    const entry = { ...copyFile(inside(sourceAssets, source), directory, destination), source };
    manifests.get(directory).set(destination, entry);
  }
  for (const file of websiteFiles) {
    add(website, file, 'assets/' + file);
    add(clientRoot, file, 'assets/' + file);
    if (file.startsWith('fonts/')) {
      const name = path.posix.basename(file);
      add(recruiterRoot, file, 'assets/app-ui/' + name);
      add(clientRoot, file, 'src/renderer/assets/' + name);
    } else if (/^brand\/(?:mark|favicon)\.png$/.test(file)) {
      add(recruiterRoot, file, 'assets/' + file);
      add(clientRoot, file, 'src/renderer/assets/' + path.posix.basename(file));
    } else if (/^brand\/tavi(?:-[a-z]+)?\.webp$/.test(file)) {
      add(recruiterRoot, file, 'assets/app-ui/' + path.posix.basename(file));
      add(clientRoot, file, 'src/renderer/assets/' + path.posix.basename(file));
    }
  }
  const icons = generateIcons(logo);
  for (const directory of [recruiterRoot, clientRoot]) {
    for (const [name, data] of [['assets/brand/app-icon.png', icons.png], ['assets/truveil.ico', icons.ico], ['assets/mac/icon.icns', icons.icns]]) {
      const destination = inside(directory, name);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      if (!fs.existsSync(destination) || !fs.readFileSync(destination).equals(data)) fs.writeFileSync(destination, data);
      manifests.get(directory).set(name, { path: name, sha256: digest(data), source: 'brand/mark.png', derived: true });
    }
  }
  for (const [directory, files] of manifests) {
    const manifest = { schema: 1, brand: 'truveil', logoSource: 'brand/mark.png', logoSourceSha256,
      sourceInventoryHash: digest(JSON.stringify(inventory)),
      files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path)) };
    const destination = inside(directory, 'assets/brand-manifest.json');
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
    if (!fs.existsSync(destination) || !fs.readFileSync(destination).equals(bytes)) fs.writeFileSync(destination, bytes);
    check(directory, { sourceAssets });
  }
  return { logoSourceSha256, surfaces: manifests.size, sharedSourceFiles: websiteFiles.length };
}

function locations() {
  const recruiter = require('../package.json').name === 'truveil-recruiter';
  return { recruiterRoot: recruiter ? root : path.resolve(root, '../TrueVeils/recruiter-app'),
    clientRoot: recruiter ? path.resolve(root, '../../Truveil-Client') : root };
}

if (require.main === module || (process.versions.electron && process.argv.includes('--render-icons'))) {
  const render = process.argv.indexOf('--render-icons');
  if (render >= 0) renderIcons(process.argv[render + 1], process.argv[render + 2]);
  else {
    try {
      const directories = locations();
      if (process.argv.includes('--sync')) {
        const result = synchronize(directories);
        console.log('Shared website/app brand assets and both platform icons synchronized. No app build or publication performed.');
        console.log(result.sharedSourceFiles + ' shared source assets verified.');
      } else {
        const sourceAssets = path.resolve(directories.recruiterRoot, '../landing/assets');
        const available = fs.existsSync(path.join(sourceAssets, 'brand/mark.png'));
        const count = check(root, { sourceAssets: available ? sourceAssets : undefined });
        console.log(count + ' local brand asset copies verified' + (available ? ' against the website source.' : '; canonical website checkout is not present.'));
      }
    } catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}

module.exports = { check, inside, synchronize };
