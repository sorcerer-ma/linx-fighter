/** Lengths and sequence numbers in Doubao envelopes are big endian. PCM is little endian. */
export function int32(value: number): Buffer { const result = Buffer.alloc(4); result.writeInt32BE(value); return result; }
export function sized(value: Buffer): Buffer { return Buffer.concat([int32(value.length), value]); }
export class Reader {
  offset: number;
  constructor(readonly data: Buffer) {
    if (data.length < 4 || data[0]! >> 4 !== 1) throw Error('invalid_speech_header');
    this.offset = (data[0]! & 15) * 4;
    if (this.offset < 4 || this.offset > data.length) throw Error('invalid_speech_header');
  }
  take(size: number): Buffer {
    if (size < 0 || this.offset + size > this.data.length) throw Error('truncated_speech_frame');
    const value = this.data.subarray(this.offset, this.offset + size); this.offset += size; return value;
  }
  number(): number { return this.take(4).readInt32BE(); }
  bytes(): Buffer { return this.take(this.number()); }
  end(): void { if (this.offset !== this.data.length) throw Error('trailing_speech_bytes'); }
}
