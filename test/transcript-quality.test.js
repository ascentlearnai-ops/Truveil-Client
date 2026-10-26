const test = require('node:test');
const assert = require('node:assert/strict');
const {
  assessTranscript,
  isRecentDuplicate,
  transcriptFingerprint
} = require('../src/transcription/quality');

test('zero confidence is low confidence; missing or invalid confidence stays unknown', () => {
  const speech = { text: 'I would retry the job.', rms: 0.03, peak: 0.2 };
  assert.equal(assessTranscript({ ...speech, confidence: 0 }).reason, 'low-confidence');
  for (const confidence of [undefined, null, '', NaN, 2, -1]) {
    const result = assessTranscript({ ...speech, confidence });
    assert.equal(result.accepted, true);
    assert.equal(result.confidence, undefined);
  }
});

test('retains low-confidence speech for review but rejects silence hallucinations', () => {
  assert.equal(assessTranscript({
    text: 'Thank you for watching.',
    confidence: 0.91,
    rms: 0.02,
    peak: 0.12
  }).accepted, false);
  const uncertain = assessTranscript({
    text: 'I led the migration and rolled it back after the queue failed.',
    confidence: 0.31,
    rms: 0.02,
    peak: 0.12
  });
  assert.equal(uncertain.accepted, true);
  assert.equal(uncertain.qualityReason, 'low-confidence');
  assert.equal(assessTranscript({
    text: 'I led the migration and rolled it back after the queue failed.',
    confidence: 0.88,
    rms: 0.001,
    peak: 0.01
  }).accepted, false);
});

test('accepts clear speech and catches duplicate final events', () => {
  const text = 'I rolled the deployment back, drained the queue, and replayed the failed jobs.';
  assert.equal(assessTranscript({ text, confidence: 0.88, rms: 0.025, peak: 0.18 }).accepted, true);
  assert.equal(isRecentDuplicate(text, [{ fingerprint: transcriptFingerprint(text), timestamp: Date.now() }]), true);
  assert.equal(isRecentDuplicate(
    'I rolled the deployment back and drained the queue before replaying failed jobs.',
    [{ fingerprint: transcriptFingerprint(text), timestamp: Date.now() }]
  ), false);
});

test('keeps quiet but credible speech instead of treating it as silence', () => {
  const text = 'I changed the cache key and verified the fix with a canary deploy.';
  assert.equal(assessTranscript({ text, confidence: 0.72, rms: 0.005, peak: 0.032 }).accepted, true);
});

test('short streaming spans preserve natural acknowledgements and single-letter words', () => {
  for (const text of ['I', 'a', 'yeah', 'okay', 'right', 'so', 'Um,']) {
    const result = assessTranscript({ text, confidence: 0.91, rms: 0.03, peak: 0.12 });
    assert.equal(result.accepted, true, text);
    assert.equal(result.text, text);
    assert.equal(result.words, 1);
  }
});

test('does not discard similar but meaningfully different technical answers', () => {
  const prior = [{
    timestamp: Date.now(),
    fingerprint: transcriptFingerprint('I would use a queue to absorb traffic spikes and protect the database while workers process jobs')
  }];
  assert.equal(isRecentDuplicate(
    'I would use a queue to absorb traffic spikes, but I would also add idempotency keys and a dead letter queue',
    prior
  ), false);
});
