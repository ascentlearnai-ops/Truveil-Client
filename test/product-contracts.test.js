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
  assert.match(source, /transcriptionWebsocketUrl/);
  assert.match(source, /startAudioFallback/);
});

test('runtime config does not contain transcription provider secrets', () => {
  const config = fs.readFileSync('src/config/runtime-config.json', 'utf8');
  assert.doesNotMatch(config, /deepgram|groq/i);
});
