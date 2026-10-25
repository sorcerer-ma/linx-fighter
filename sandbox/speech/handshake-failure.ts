import { vendorCode } from './diagnostics.js';
export type ProviderReason = 'resource_not_granted' | 'grant_not_found' | 'concurrency_quota';
/** Official documented identifiers only; never return message text or captured substrings. */
export function handshakeFailure(body: Buffer): { providerReason?: ProviderReason; vendorCode?: number } {
  if (body.length > 4096) return {};
  const text = body.toString('utf8');
  let payload: any;
  try { payload = JSON.parse(text); } catch { /* Some gateways use plain text. */ }
  const message = typeof payload?.message === 'string' ? payload.message
    : typeof payload?.error?.message === 'string' ? payload.error.message : payload === undefined ? text : '';
  let providerReason: ProviderReason | undefined;
  if (message.includes('requested resource not granted')) providerReason = 'resource_not_granted';
  else if (message.includes('authenticate request: load grant: requested grant not found')) providerReason = 'grant_not_found';
  else if (message.includes('quota exceeded for types: concurrency')) providerReason = 'concurrency_quota';
  return { providerReason, vendorCode: vendorCode(payload) ?? vendorCode(payload?.error) };
}
