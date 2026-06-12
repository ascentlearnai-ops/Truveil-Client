class TruveilPcmProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.targetRate = Number(options.processorOptions?.targetRate) || 16000;
    this.sourceRate = sampleRate;
    this.ratio = this.sourceRate / this.targetRate;
    this.pending = [];
    this.frameSamples = Math.round(this.targetRate * 0.2);
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input?.length) return true;

    for (let index = 0; index < input.length; index += this.ratio) {
      const value = Math.max(-1, Math.min(1, input[Math.floor(index)] || 0));
      this.pending.push(value < 0 ? value * 0x8000 : value * 0x7fff);
    }

    while (this.pending.length >= this.frameSamples) {
      const frame = new Int16Array(this.pending.splice(0, this.frameSamples));
      this.port.postMessage(frame.buffer, [frame.buffer]);
    }
    return true;
  }
}

registerProcessor('truveil-pcm-processor', TruveilPcmProcessor);
