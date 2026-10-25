import { gunzipSync } from 'node:zlib';
import { SpeechFailure } from './diagnostics.js';
import { Reader, int32, sized } from './binary.js';
/** Per official protocols_.py: event 50/51/52 carry connect_id, other server events session_id. */
export function ttsRequest(event: number, payload: object = {}, session = ''): Buffer {
  const parts = [Buffer.from([0x11, 0x14, 0x10, 0]), int32(event)];
  if (event !== 1 && event !== 2) parts.push(sized(Buffer.from(session)));
  parts.push(sized(Buffer.from(JSON.stringify(payload))));
  return Buffer.concat(parts);
}
export function parseTts(data: Buffer): { event: number; id: string; payload: Buffer; audio: boolean } {
  const reader = new Reader(data), type = data[1]! >> 4;
  if (type === 15) { const code = reader.number(); reader.bytes(); reader.end(); throw new SpeechFailure('tts_protocol', 'vendor', { vendorCode: code }); }
  if ((type !== 9 && type !== 11) || (data[1]! & 15) !== 4) throw Error('unexpected_tts_frame');
  const event = reader.number();
  const id = reader.bytes().toString('utf8');
  let payload = reader.bytes(); reader.end();
  const compression = data[2]! & 15;
  if (compression === 1) payload = gunzipSync(payload, { maxOutputLength: 8 * 1024 * 1024 });
  else if (compression !== 0) throw Error('unsupported_tts_compression');
  return { event, id, payload, audio: type === 11 && event === 352 };
}
export function pcmWav(pcm: Buffer, rate = 24000): Buffer {
  if (pcm.length % 2) throw Error('odd_pcm_bytes');
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
