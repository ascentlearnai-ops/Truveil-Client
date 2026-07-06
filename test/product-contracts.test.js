const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('client website downloads the local Windows installer', () => {
  const html = fs.readFileSync('index.html', 'utf8');
  assert.match(html, /\/downloads\/TruveilSecure-Setup-1\.0\.0\.exe/);
  assert.doesNotMatch(html, /github\.com\/.*releases/i);
  assert.match(html, /secure-demo/);
  assert.match(html, /secure-window/);
  assert.doesNotMatch(html, /candidate-app-real\.png|truveil-horizontal-transparent\.png/i);
});

test('candidate active screen does not reveal recruiter risk analysis', () => {
  const html = fs.readFileSync('src/renderer/index.html', 'utf8');
  assert.doesNotMatch(html, /AI-assistance risk|integrity percent|cheating score/i);
});

test('candidate setup includes swipeable instructional cards', () => {
  const html = fs.readFileSync('src/renderer/index.html', 'utf8');
  const renderer = fs.readFileSync('src/renderer/session.js', 'utf8');
  assert.match(html, /instruction-carousel/);
  assert.match(html, /Open your invite/);
  assert.match(html, /Review and consent/);
  assert.match(html, /Allow microphone/);
  assert.match(html, /Keep this open/);
  assert.match(renderer, /setupInstructionCarousel/);
  assert.match(renderer, /pointerdown/);
  assert.match(renderer, /ArrowRight/);
  assert.doesNotMatch(html, /AI-assistance risk|integrity percent|cheating score/i);
});

test('candidate consent clearly discloses collected and excluded information', () => {
  const html = fs.readFileSync('src/renderer/index.html', 'utf8');
  const renderer = fs.readFileSync('src/renderer/session.js', 'utf8');
  assert.match(html, /Microphone transcript/);
  assert.match(html, /Foreground activity/);
  assert.match(html, /No camera/);
  assert.match(html, /No screen recording/);
  assert.match(html, /No file or clipboard access/);
  assert.match(html, /No automatic hiring decision/);
  assert.match(renderer, /confirm the session verification notice/i);
});

test('client legal pages disclose product boundaries', () => {
  const privacy = fs.readFileSync('privacy.html', 'utf8');
  const terms = fs.readFileSync('terms.html', 'utf8');
  const legal = fs.readFileSync('legal.html', 'utf8');
  assert.match(privacy, /No camera video/i);
  assert.match(privacy, /No screen recording/i);
  assert.match(privacy, /No clipboard collection/i);
  assert.match(terms, /does not automatically decide/i);
  assert.match(legal, /No hidden candidate-facing risk score/i);
});

test('candidate uses secure live transcription before fallback audio', () => {
  const source = fs.readFileSync('src/renderer/session.js', 'utf8');
  assert.match(source, /startLiveTranscription\(\)/);
  assert.match(source, /getTranscriptionToken/);
  assert.match(source, /AudioWorkletNode/);
  assert.doesNotMatch(source, /SpeechRecognition|webkitSpeechRecognition/);
  assert.match(source, /startAudioFallback/);
});

test('live transcript cadence uses stable utterance ids and balanced fallback chunks', () => {
  const renderer = fs.readFileSync('src/renderer/session.js', 'utf8');
  const main = fs.readFileSync('main.js', 'utf8');
  assert.match(renderer, /const AUDIO_SEGMENT_MS = 2500/);
  assert.match(renderer, /endpointing:\s*'300'/);
  assert.match(renderer, /utterance_end_ms:\s*'1000'/);
  assert.match(renderer, /setInterval\(\(\) => \{[\s\S]*KeepAlive[\s\S]*\}, 4000\)/);
  assert.match(renderer, /liveStreamEpoch/);
  assert.match(renderer, /liveUtteranceId/);
  assert.match(main, /streamEpoch/);
  assert.match(main, /utteranceId/);
  assert.match(main, /finalReason/);
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

test('candidate joins with a TRV code without Supabase anonymous auth', () => {
  const source = fs.readFileSync('main.js', 'utf8');
  const joinBlock = source.match(/async function joinSessionThroughFunction[\s\S]*?async function validateSession/);
  assert.ok(joinBlock, 'joinSessionThroughFunction block should exist');
  assert.match(joinBlock[0], /candidate-join/);
  assert.doesNotMatch(joinBlock[0], /signInAnonymously|ensureAnonymousAuth/);
  assert.match(joinBlock[0], /Bearer \$\{supabaseAnonKey\}/);
});
