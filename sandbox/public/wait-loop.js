/** One sequential long-poll owner. Game actions are never retried here. */
export function wantsWait(data) {
  return !!data && data.ok !== false && !data.isError && !data.silent && data.protocol?.v === 2
    && !['unknown', 'failed'].includes(data.protocol.reason)
    && ['room', 'battle'].includes(data.protocol.phase)
    && (data.protocol.need === 'wait_guest' || data.protocol.need === 'wait_foe');
}
export function quietWaitTimeout(data) {
  const facts = data?.protocol;
  return data?.ok !== false && !data?.isError && data?.rewriteStatus === 'wait-timeout'
    && facts?.ok === true && !facts.silent && !facts.text && ['room','battle'].includes(facts.phase)
    && (facts.need === 'wait_guest' || facts.need === 'wait_foe')
    && facts.events?.length > 0 && facts.events.every(event => event.t === 'timeout'
      && event.what === (facts.need === 'wait_guest' ? 'guest' : 'foe'));
}
export async function runWaitLoop({ request, present, isCurrent }) {
  while (isCurrent()) {
    const data = await request();
    if (!isCurrent()) return;
    if (quietWaitTimeout(data)) continue;
    const playback = await present(data);
    if (!isCurrent() || !wantsWait(data) || !['ended', 'displayed'].includes(playback)) return;
  }
}
