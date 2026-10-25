/** Session-local conversation; follow new messages only while viewing the bottom. */
export function createConversation(viewport, list, latestButton) {
  const doc = list.ownerDocument;
  const view = doc.defaultView;
  const labels = { player: '玩家', partner: '伙伴', system: '系统' };
  let following = true;
  let frame = null;

  function schedule() {
    if (frame !== null) return;
    frame = view.requestAnimationFrame(() => {
      frame = null;
      if (following) viewport.scrollTop = viewport.scrollHeight;
      latestButton.hidden = following;
    });
  }
  viewport.addEventListener('scroll', () => {
    following = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= 24;
    latestButton.hidden = following;
  }, { passive: true });
  latestButton.addEventListener('click', () => {
    following = true;
    schedule();
  });
  const resize = new view.ResizeObserver(schedule);
  resize.observe(list);
  resize.observe(viewport);

  return {
    append(role, text, tone = 'normal') {
      const value = String(text ?? '').trim();
      if (!value) return;
      const item = doc.createElement('li');
      item.dataset.role = role;
      item.dataset.tone = tone;
      const label = doc.createElement('span');
      label.className = 'message-speaker';
      label.textContent = labels[role];
      const body = doc.createElement('p');
      body.className = 'message-text';
      body.textContent = value;
      item.append(label, body);
      list.append(item);
      schedule();
    }
  };
}
