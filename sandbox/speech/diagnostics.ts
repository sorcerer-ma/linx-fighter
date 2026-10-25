import type { ProviderReason } from './handshake-failure.js';
/** Explicit metadata only. Error messages, response bodies and request headers never enter diagnostics. */
export type SpeechStage = 'ws_handshake' | 'tts_connection' | 'tts_session' | 'tts_stream' | 'tts_finish' | 'tts_protocol';
export type SpeechReason = 'http' | 'network' | 'closed' | 'cancelled' | 'timeout' | 'vendor' | 'protocol' | 'audio' | 'internal';
export interface SpeechTrace { connectId?: string; logId?: string }
const NETWORK_CODES = ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH', 'EACCES', 'EPERM', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'ERR_TLS_CERT_ALTNAME_INVALID'];
export function networkCode(value: unknown): string | undefined { return typeof value === 'string' && NETWORK_CODES.includes(value) ? value : undefined; }
export interface SpeechFailureFields extends SpeechTrace { httpStatus?: number; vendorCode?: number; networkCode?: string; providerReason?: ProviderReason }
export class SpeechFailure extends Error {
  constructor(readonly stage: SpeechStage, readonly reason: SpeechReason, readonly fields: SpeechFailureFields = {}) {
    super(`speech_${stage}_${reason}`);
  }
}
const traces = new WeakMap<object, SpeechTrace>();
export function setSpeechTrace(socket: object, trace: SpeechTrace): void { traces.set(socket, trace); }
export function getSpeechTrace(socket: object): SpeechTrace { return traces.get(socket) ?? {}; }
export function safeId(value: unknown, secret = ''): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(value)
    && (!secret || !value.includes(secret)) ? value : undefined;
}
export function vendorCode(payload: unknown): number | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const value = payload as Record<string, unknown>;
  const code = value.status_code ?? value.code ?? value.error_code;
  return typeof code === 'number' && Number.isSafeInteger(code) && code >= 0 ? code : undefined;
}
export function diagnostic(error: unknown, requestId: string, started: number) {
  const failure = error instanceof SpeechFailure ? error : new SpeechFailure('tts_protocol', 'internal');
  return { stage: failure.stage, reason: failure.reason, ...failure.fields, requestId, elapsedMs: Math.max(0, Date.now() - started) };
}
