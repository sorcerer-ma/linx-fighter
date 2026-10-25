/** 100ms signed 16-bit mono PCM, little endian. AudioContext requests 16kHz. */
class PcmCapture extends AudioWorkletProcessor {
  constructor() { super(); this.samples = []; this.phase = 0; this.sum = 0; this.count = 0; }
  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;
    const ratio = sampleRate / 16000;
    for (const value of input) {
      this.sum += value; this.count++; this.phase++;
      if (this.phase >= ratio) {
        this.phase -= ratio;
        this.samples.push(Math.max(-1, Math.min(1, this.sum / this.count)));
        this.sum = 0; this.count = 0;
      }
      if (this.samples.length === 1600) {
        const buffer = new ArrayBuffer(3200), view = new DataView(buffer);
        this.samples.forEach((sample, index) => view.setInt16(index * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true));
        this.port.postMessage(buffer, [buffer]); this.samples = [];
      }
    }
    return true;
  }
}
registerProcessor('pcm-capture', PcmCapture);
