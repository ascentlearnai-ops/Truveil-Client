class TruveilPcmProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.targetRate = Number(options.processorOptions?.targetRate) || 16000;
    this.sourceRate = sampleRate;
    this.ratio = this.sourceRate / this.targetRate;
    this.pending = [];
    this.frameSamples = Math.round(this.targetRate * 0.2);
    this.sourceBuffer = [];
    this.sourcePosition = 0;
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input?.length) return true;

    this.sourceBuffer.push(...input);
    while (this.sourcePosition + 1 < this.sourceBuffer.length) {
      const left = Math.floor(this.sourcePosition);
      const fraction = this.sourcePosition - left;
      const value = Math.max(-1, Math.min(1,
        this.sourceBuffer[left] * (1 - fraction) + this.sourceBuffer[left + 1] * fraction
      ));
      this.pending.push(value < 0 ? value * 0x8000 : value * 0x7fff);
      this.sourcePosition += this.ratio;
    }
    const consumed = Math.floor(this.sourcePosition);
    if (consumed > 0) {
      this.sourceBuffer.splice(0, consumed);
      this.sourcePosition -= consumed;
    }

    while (this.pending.length >= this.frameSamples) {
      const frame = new Int16Array(this.pending.splice(0, this.frameSamples));
      this.port.postMessage(frame.buffer, [frame.buffer]);
    }
    return true;
  }
}

registerProcessor('truveil-pcm-processor', TruveilPcmProcessor);
