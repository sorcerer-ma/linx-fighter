/** Only structured, allowlisted diagnostic fields are rendered; supplier messages never are. */
export function speechDiagnostic(value) {
  if (!value || !['ws_handshake', 'tts_connection', 'tts_session', 'tts_stream', 'tts_finish', 'tts_protocol'].includes(value.stage)
    || !['http', 'network', 'closed', 'cancelled', 'timeout', 'vendor', 'protocol', 'audio', 'internal'].includes(value.reason)) return null;
  const result = { stage: value.stage, reason: value.reason };
  if (['resource_not_granted', 'grant_not_found', 'concurrency_quota'].includes(value.providerReason)) result.providerReason = value.providerReason;
  for (const key of ['httpStatus', 'vendorCode', 'elapsedMs']) {
    if (Number.isSafeInteger(value[key]) && value[key] >= 0) result[key] = value[key];
  }
  if (typeof value.networkCode === 'string' && /^[A-Z][A-Z0-9_]{2,63}$/.test(value.networkCode)) result.networkCode = value.networkCode;
  for (const key of ['requestId', 'connectId', 'logId']) {
    if (typeof value[key] === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(value[key])) result[key] = value[key];
  }
  return result;
}
export function diagnosticText(value) {
  const detail = speechDiagnostic(value);
  if (!detail) return '';
  const fields = [`阶段 ${detail.stage}`, `原因 ${detail.reason}`];
  if (detail.providerReason) fields.push(`供应商原因分类 ${detail.providerReason}`);
  if (detail.networkCode) fields.push(`网络码 ${detail.networkCode}`);
  if (detail.httpStatus !== undefined) fields.push(`HTTP ${detail.httpStatus}`);
  if (detail.vendorCode !== undefined) fields.push(`供应商码 ${detail.vendorCode}`);
  if (detail.elapsedMs !== undefined) fields.push(`耗时 ${detail.elapsedMs}ms`);
  if (detail.requestId) fields.push(`请求 ${detail.requestId}`);
  if (detail.connectId) fields.push(`连接 ${detail.connectId}`);
  if (detail.logId) fields.push(`日志 ${detail.logId}`);
  return fields.join('\n');
}
