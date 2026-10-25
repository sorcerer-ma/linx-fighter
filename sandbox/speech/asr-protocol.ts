import { gzipSync, gunzipSync } from 'node:zlib';
import { Reader, sized } from './binary.js';
export function asrInit(): Buffer {
  const payload = { user: { uid: 'linx-sandbox' }, audio: { format: 'pcm', codec: 'raw', rate: 16000, bits: 16, channel: 1 },
    request: { model_name: 'bigmodel', enable_nonstream: true, show_utterances: true, result_type: 'single', enable_itn: false, enable_ddc: false, enable_punc: true } };
  return Buffer.concat([Buffer.from([0x11, 0x10, 0x11, 0]), sized(gzipSync(JSON.stringify(payload)))]);
}
export function asrAudio(pcm: Buffer, last = false): Buffer {
  if (pcm.length % 2) throw Error('odd_pcm_bytes');
  return Buffer.concat([Buffer.from([0x11, last ? 0x22 : 0x20, 0x01, 0]), sized(gzipSync(pcm))]);
}
export function parseAsr(data: Buffer): { payload: any; last: boolean } {
  const reader = new Reader(data), type = data[1]! >> 4, flags = data[1]! & 15;
  if (type === 15) { const code = reader.number(); throw Error(`asr_vendor_${code}`); }
  if (type !== 9 || (flags & ~3)) throw Error('unexpected_asr_frame');
  if (flags & 1) reader.number();
  let payload = reader.bytes(); reader.end();
  const compression = data[2]! & 15;
  if (compression === 1) payload = gunzipSync(payload, { maxOutputLength: 1024 * 1024 });
  else if (compression !== 0) throw Error('unsupported_asr_compression');
  if (data[2]! >> 4 !== 1) throw Error('expected_asr_json');
  return { payload: JSON.parse(payload.toString('utf8')), last: Boolean(flags & 2) };
}
/** IDs are scoped to this one socket, preserving repeated identical spoken sentences. */
export function asrResults() {
  const finals = new Set<number>();
  return (payload: any): { id: string; text: string; final: boolean }[] => {
    const utterances = payload.result?.utterances;
    if (!Array.isArray(utterances) || utterances.length === 0) return payload.result?.text ? [{ id: 'partial', text: payload.result.text, final: false }] : [];
    return utterances.flatMap((utterance: any) => {
      if (typeof utterance.text !== 'string') return [];
      const final = utterance.definite === true;
      if (final && (typeof utterance.start_time !== 'number' || finals.has(utterance.start_time))) return [];
      if (final) finals.add(utterance.start_time);
      return [{ id: String(utterance.start_time), text: utterance.text, final }];
    });
  };
}
