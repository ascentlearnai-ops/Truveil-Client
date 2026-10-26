const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../src/audio/pcm-worklet.js'), 'utf8');

function resample(input, rate, blockSize) {
  let Processor;
  const frames = [];
  vm.runInNewContext(source, {
    sampleRate: rate,
    AudioWorkletProcessor: class { constructor() { this.port = { postMessage: buffer => frames.push(...new Int16Array(buffer)) }; } },
    registerProcessor: (_name, constructor) => Processor = constructor
  });
  const processor = new Processor({ processorOptions: { targetRate: 16000 } });
  for (let offset = 0; offset < input.length; offset += blockSize) processor.process([[input.subarray(offset, offset + blockSize)]]);
  return [...frames, ...new Int16Array(processor.pending)];
}

for (const rate of [16000, 44100, 48000]) {
  test(`PCM ${rate} Hz preserves sample count and phase across render quanta`, () => {
    const input = Float32Array.from({ length: rate }, (_, i) => 0.7 * Math.sin(2 * Math.PI * 731 * i / rate));
    const actual = resample(input, rate, 128);
    const reference = resample(input, rate, rate);
    assert.equal(actual.length, reference.length);
    assert.ok(Math.abs(actual.length - 16000) <= 1);
    assert.ok(actual.every((sample, i) => Math.abs(sample - reference[i]) <= 1));
    assert.equal(resample(input, rate, 37).length, actual.length);
  });
}

test('PCM saturates synthetic out-of-range audio without integer wrap', () => {
  const result = resample(Float32Array.from([2, -2, 1, -1, 0]), 16000, 2);
  assert.deepEqual(result, [32767, -32768, 32767, -32768]);
});

test('PCM emits 50 ms frames with bounded pending samples', () => {
  let Processor;
  const frames = [];
  vm.runInNewContext(source, {
    sampleRate: 48000,
    AudioWorkletProcessor: class { constructor() { this.port = { postMessage: buffer => frames.push(new Int16Array(buffer)) }; } },
    registerProcessor: (_name, constructor) => Processor = constructor
  });
  const processor = new Processor({ processorOptions: { targetRate: 16000 } });
  for (let i = 0; i < 375; i++) processor.process([[new Float32Array(128)]]);
  assert.equal(processor.frameSamples, 800);
  assert.ok(frames.length >= 19);
  assert.ok(frames.every(frame => frame.length === 800));
  assert.ok(processor.pending.length < 800);
  assert.ok(processor.sourceBuffer.length < 4);
});
