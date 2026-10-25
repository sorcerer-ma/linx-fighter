import { PROTOCOL_REPLY_MAX_BYTES, type GameReply } from '../game/protocol.js';

/** Complete compact JSON only: never truncate facts or produce an invalid fragment. */
export function encodeReply(reply: GameReply): string {
  const text = JSON.stringify(reply);
  if (Buffer.byteLength(text, 'utf8') > PROTOCOL_REPLY_MAX_BYTES) {
    throw new RangeError('ProtocolReplyTooLarge');
  }
  return text;
}

/** No snapshot is invented when execution or the subsequent read may have failed. */
export function unknownReply(): GameReply {
  return {
    v: 2, ok: false, reason: 'unknown', events: [],
    say: '刚才的结果还未确认，请先核实战况，不要重复出招。',
  };
}
