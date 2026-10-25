import { handshakeFailure } from './handshake-failure.js';
import { SpeechFailure, safeId, setSpeechTrace, networkCode } from './diagnostics.js';
import WebSocket from 'ws';
import type { ConnectSpeech } from './doubao.js';
/** Credentials only travel in upgrade headers. Never follow redirects or expose provider errors. */
export const connectSpeech: ConnectSpeech = (url, headers, signal) => new Promise((resolve, reject) => {
  if (signal.aborted) { reject(new SpeechFailure('ws_handshake', 'cancelled')); return; }
  const socket = new WebSocket(url, {
    headers, handshakeTimeout: 5000, maxPayload: 8 * 1024 * 1024,
    perMessageDeflate: false, followRedirects: false,
  });
  let opened = false, failedUpgrade = false;
  const trace = { connectId: safeId(headers['X-Api-Connect-Id']), logId: undefined as string | undefined };
  setSpeechTrace(socket, trace);
  socket.on('upgrade', response => { trace.logId = safeId(response.headers['x-tt-logid'], headers['X-Api-Key']); });
  socket.on('unexpected-response', (_request, response) => {
    failedUpgrade = true;
    trace.logId = safeId(response.headers['x-tt-logid'], headers['X-Api-Key']);
    const chunks: Buffer[] = [];
    let size = 0, finished = false;
    const finish = (fields = {}) => {
      if (finished) return;
      finished = true; clearTimeout(timer); chunks.length = 0;
      reject(new SpeechFailure('ws_handshake', 'http', { ...trace, httpStatus: response.statusCode, ...fields }));
      response.destroy(); socket.terminate();
    };
    const timer = setTimeout(() => finish(), 1000);
    response.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 4096) finish(); else chunks.push(chunk);
    });
    response.on('end', () => finish(handshakeFailure(Buffer.concat(chunks))));
    response.on('error', () => finish());
    response.on('aborted', () => finish());
  });
  const cancel = () => { socket.terminate(); reject(new SpeechFailure('ws_handshake', 'cancelled', trace)); };
  signal.addEventListener('abort', cancel, { once: true });
  socket.on('open', () => {
    if (signal.aborted) { cancel(); return; }
    opened = true; resolve(socket);
  });
  // Keep an error listener after resolving: failed sockets must never cause an uncaught error.
  socket.on('error', error => {
    if (failedUpgrade) return;
    reject(new SpeechFailure('ws_handshake',
      error.message === 'Opening handshake has timed out' ? 'timeout' : 'network',
      { ...trace, networkCode: networkCode((error as NodeJS.ErrnoException).code) }));
  });
  socket.on('close', () => {
    signal.removeEventListener('abort', cancel);
    if (!opened && !failedUpgrade) reject(new SpeechFailure('ws_handshake', 'closed', trace));
  });
});
