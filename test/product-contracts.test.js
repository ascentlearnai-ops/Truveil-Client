const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('client website downloads the local Windows installer', () => {
  const html = fs.readFileSync('index.html', 'utf8');
  assert.match(html, /\/downloads\/TruveilSecure-Setup-1\.0\.0\.exe/);
  assert.doesNotMatch(html, /github\.com\/.*releases/i);
});

test('candidate active screen does not reveal recruiter risk analysis', () => {
  const html = fs.readFileSync('src/renderer/index.html', 'utf8');
  assert.doesNotMatch(html, /AI-assistance risk|integrity percent|cheating score/i);
});

test('candidate uses secure live transcription before fallback audio', () => {
  const source = fs.readFileSync('src/renderer/session.js', 'utf8');
  assert.match(source, /startLiveTranscription\(\)/);
  assert.match(source, /getTranscriptionToken/);
  assert.match(source, /AudioWorkletNode/);
  assert.doesNotMatch(source, /SpeechRecognition|webkitSpeechRecognition/);
  assert.match(source, /startAudioFallback/);
});

test('runtime config does not contain transcription provider secrets', () => {
  const config = fs.readFileSync('src/config/runtime-config.json', 'utf8');
  assert.doesNotMatch(config, /deepgram|groq/i);
});

test('packaged client includes the PCM worklet and transcript quality modules', () => {
  const build = fs.readFileSync('electron-builder.yml', 'utf8');
  assert.match(build, /src\/audio\/\*\*\/\*/);
  assert.match(build, /src\/transcription\/\*\*\/\*/);
});

test('ordinary destinations are observed while known restricted targets are closed', () => {
  const source = fs.readFileSync('main.js', 'utf8');
  assert.match(source, /unlisted:\s*true/);
  assert.match(source, /closeForegroundRestrictedTarget/);
  assert.match(source, /policyDecision:\s*decision\.unlisted\s*\?\s*'unlisted'/);
});

test('candidate join explains disabled Supabase anonymous auth', () => {
  const source = fs.readFileSync('main.js', 'utf8');
  assert.match(source, /Supabase Anonymous sign-ins are disabled/);
  assert.match(source, /Authentication > Providers > Anonymous/);
});
