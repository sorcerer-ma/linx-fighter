/** Recognition-compatible, half duplex backend capture. No raw audio is retained. */
export class BackendRecognition {
  start() {
    this.controller = new AbortController();
    this.capture(this.controller).catch(() => {
      if (!this.controller?.signal.aborted) { this.abort(); this.onerror?.({ error: 'backend-failed' }); }
    });
  }
  async capture(controller) {
    const { signal } = controller;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    if (signal.aborted) { stream.getTracks().forEach(track => track.stop()); return; }
    this.stream = stream;
    const context = this.context = new AudioContext({ sampleRate: 16000 });
    await context.audioWorklet.addModule('/pcm-worklet.js');
    if (signal.aborted) return;
    const response = await fetch('/api/speech/asr/start', { method: 'POST', signal });
    if (!response.ok) throw Error('asr_start_failed');
    const { id } = await response.json();
    if (signal.aborted) { fetch(`/api/speech/asr/${id}`, { method: 'DELETE' }).catch(() => {}); return; }
    this.id = id;
    const source = this.source = new EventSource(`/api/speech/asr/${id}`);
    source.onerror = () => { if (!signal.aborted) { this.abort(); this.onerror?.({ error: 'backend-failed' }); } };
    source.onmessage = event => {
      if (signal.aborted) return;
      const data = JSON.parse(event.data);
      if (data.end) { this.abort(); this.onend?.(); return; }
      if (data.error) { this.abort(); this.onerror?.({ error: data.error }); return; }
      const result = [{ transcript: data.text }]; result.isFinal = data.final;
      this.onresult?.({ resultIndex: 0, results: [result] });
    };
    source.onopen = () => {
      if (signal.aborted) return;
      const microphone = context.createMediaStreamSource(stream);
      const worklet = this.worklet = new AudioWorkletNode(context, 'pcm-capture');
      const mute = context.createGain(); mute.gain.value = 0;
      microphone.connect(worklet); worklet.connect(mute); mute.connect(context.destination);
      let chain = Promise.resolve(), queued = 0;
      worklet.port.onmessage = event => {
        if (signal.aborted) return;
        if (++queued > 10) { this.abort(); this.onerror?.({ error: 'audio_backpressure' }); return; }
        chain = chain.then(async () => {
          if (signal.aborted) return;
          const sent = await fetch(`/api/speech/asr/${id}/audio`, { method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream' }, body: event.data, signal });
          if (!sent.ok) throw Error('audio_upload_failed');
        }).catch(() => { if (!signal.aborted) { this.abort(); this.onerror?.({ error: 'audio_upload_failed' }); } }).finally(() => queued--);
      };
      context.resume().catch(() => { if (!signal.aborted) this.onerror?.({ error: 'audio_context_failed' }); });
      this.onstart?.();
    };
  }
  abort() {
    this.controller?.abort(); this.source?.close(); this.worklet?.disconnect();
    this.stream?.getTracks().forEach(track => track.stop());
    this.context?.close().catch(() => {});
    if (this.id) fetch(`/api/speech/asr/${this.id}`, { method: 'DELETE' }).catch(() => {});
    this.id = null;
  }
}
