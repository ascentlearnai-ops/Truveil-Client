const test = require('node:test');
const assert = require('node:assert/strict');
const {
  assessTranscript,
  isRecentDuplicate,
  transcriptFingerprint
} = require('../src/transcription/quality');

test('rejects low-confidence final transcripts and silence hallucinations', () => {
  assert.equal(assessTranscript({
    text: 'Thank you for watching.',
    confidence: 0.91,
    rms: 0.02,
    peak: 0.12
  }).accepted, false);
  assert.equal(assessTranscript({
    text: 'I led the migration and rolled it back after the queue failed.',
    confidence: 0.31,
    rms: 0.02,
    peak: 0.12
  }).accepted, false);
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
