/** One user-enabled session; browser recognizers may end between phrases. */
export function createListeningSession({ Recognition, onState, onText, onFinal, onError }) {
  let enabled = false, paused = false, recognizer = null, restart = null;
  function notify(active = false) { onState({ enabled, active, paused }); }
  function cancel() {
    clearTimeout(restart);
    restart = null;
    const current = recognizer;
    recognizer = null;
    if (current) current.abort();
    notify();
  }
  function stop() { enabled = false; cancel(); }
  function begin() {
    if (!enabled || paused || recognizer) return;
    clearTimeout(restart);
    restart = null;
    const current = new Recognition();
    recognizer = current;
    current.lang = 'zh-CN';
    current.interimResults = true;
    current.continuous = false;
    current.maxAlternatives = 1;
    current.onstart = () => { if (recognizer === current) notify(true); };
    current.onresult = event => {
      if (recognizer !== current) return;
      let text = '', finalText = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        text += event.results[i][0].transcript;
        if (event.results[i].isFinal) finalText += event.results[i][0].transcript;
      }
      onText(text, Boolean(finalText));
      if (finalText.trim()) {
        paused = true;
        cancel(); // Ignore further callbacks from this recognizer before sending.
        onFinal(finalText.trim());
      }
    };
    current.onerror = event => {
      if (recognizer !== current) return;
      if (event.error === 'no-speech') return; // Normal silence; onend restarts.
      stop();
      onError(event.error);
    };
    current.onend = () => {
      if (recognizer !== current) return;
      recognizer = null;
      notify();
      if (enabled && !paused) restart = setTimeout(begin, 300);
    };
    notify();
    try { current.start(); }
    catch { stop(); onError('start-failed'); }
  }
  return {
    start() { enabled = true; paused = false; begin(); },
    stop,
    pause() { paused = true; cancel(); },
    resume() { paused = false; begin(); },
    get enabled() { return enabled; }
  };
}
