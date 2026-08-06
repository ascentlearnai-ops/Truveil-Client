const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('candidate website keeps the check-in humane and explicit', () => {
  const html = fs.readFileSync('index.html', 'utf8');
  assert.match(html, /One code\. A clear check-in\. Then your interview\./);
  assert.match(html, /Consent before monitoring/i);
  assert.match(html, /No biometric scoring/i);
  assert.doesNotMatch(html, /candidate risk score|cheating score/i);
});

test('candidate website preserves invite deep links and interactive consent steps', () => {
  const html = fs.readFileSync('index.html', 'utf8');
  const script = fs.readFileSync('site.js', 'utf8');
  assert.match(html, /data-demo-step="1"/);
  assert.match(script, /truveil:\/\/join\?code=/);
  assert.match(script, /document\.querySelectorAll\('\.code-preview'\)/);
  assert.match(script, /prefers-reduced-motion/);
});
