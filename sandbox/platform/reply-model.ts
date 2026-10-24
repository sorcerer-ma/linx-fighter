/** OpenAI-compatible Chat Completions expression adapter; not connected to live
 * replies until an authoritative, testable fact-preservation contract exists.
 * Reference: https://opencode.ai/v2/docs/console/models/
 */
export interface ReplyModelOptions {
  baseUrl: string;
  model: string;
  apiKey: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}
export class OpenAiReplyModel {
  constructor(private readonly options: ReplyModelOptions) {}
  async rewrite(system: string, sourceText: string): Promise<string> {
    const response = await (this.options.fetchImpl ?? fetch)(this.options.baseUrl.replace(/\/$/,'') + '/chat/completions', {
      method:'POST',
      headers:{'Content-Type':'application/json',Authorization:'Bearer '+this.options.apiKey},
      body:JSON.stringify({model:this.options.model,stream:false,messages:[{role:'system',content:system},{role:'user',content:JSON.stringify({sourceText})}]}),
      signal:AbortSignal.timeout(this.options.timeoutMs),
    });
    if (!response.ok) throw new Error('表达模型请求失败：HTTP '+response.status);
    const result = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> };
    const content = result.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) throw new Error('表达模型没有返回有效文本');
    return content.trim();
  }
}
