const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..');
const installerName = 'TruveilSecure-Setup-1.0.0.exe';
const installerPath = path.join(repoRoot, 'downloads', installerName);
const checksumPath = `${installerPath}.sha256`;
const websitePath = path.join(repoRoot, 'index.html');
const runtimeConfigPath = path.join(repoRoot, 'src', 'config', 'runtime-config.json');
const candidateUiPath = path.join(repoRoot, 'src', 'renderer', 'index.html');

function fail(message) {
  throw new Error(message);
}

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function assertExists(file, label) {
  if (!fs.existsSync(file)) fail(`${label} is missing: ${file}`);
}

function assertNoPlaceholders(value, label) {
  const text = String(value || '').trim();
  if (!text) fail(`${label} is missing.`);
  if (/dummy|placeholder|example|your[_-]?supabase|localhost/i.test(text)) {
    fail(`${label} still looks like a placeholder.`);
  }
}

assertExists(installerPath, 'Client installer');
assertExists(checksumPath, 'Client installer checksum');
assertExists(websitePath, 'Client website');
assertExists(runtimeConfigPath, 'Runtime config');
assertExists(candidateUiPath, 'Candidate UI');

const actualHash = sha256(installerPath);
const recordedHash = read(checksumPath).split(/\s+/)[0]?.toLowerCase();
if (actualHash !== recordedHash) fail('Client installer checksum does not match the current download.');

const website = read(websitePath);
if (!website.includes(`/downloads/${installerName}`)) fail('Client website does not point at the site-local installer.');
if (/github\.com\/.*releases/i.test(website)) fail('Client website still links primary downloads to GitHub releases.');

const candidateUi = read(candidateUiPath);
if (/AI-assistance risk|integrity percent|cheating score/i.test(candidateUi)) {
  fail('Candidate UI exposes recruiter-only risk language.');
}

const runtimeConfig = JSON.parse(read(runtimeConfigPath));
assertNoPlaceholders(runtimeConfig.supabaseUrl, 'TRUVEIL_SUPABASE_URL');
assertNoPlaceholders(runtimeConfig.supabaseAnonKey, 'TRUVEIL_SUPABASE_ANON_KEY');
for (const key of Object.keys(runtimeConfig)) {
  if (/deepgram|groq|openai|api[_-]?key|secret/i.test(key)) {
    fail(`Runtime config contains a provider secret-like key: ${key}`);
  }
}

console.log('Release check passed: client installer, checksum, website download, and runtime config are ready.');
