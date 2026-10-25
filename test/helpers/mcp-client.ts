import assert from 'node:assert/strict';

/**
 * 手写的 MCP SSE 客户端，只用于端到端测试。
 *
 * 不用 SDK 自带的客户端，是为了按灵矽平台的真实调用方式验证契约：
 * 1. GET /mcp 建立 SSE 长连接；
 * 2. 服务端先推一条 endpoint 事件，告诉客户端 POST 地址；
 * 3. POST /mcp/message 下发 JSON-RPC 请求，响应从 SSE 通道回来。
 */

export interface SseEvent {
  event: string;
  data: string;
}

export interface JsonRpcResponse {
  jsonrpc: string;
  id: number | string | null;
  result?: any;
  error?: { code: number; message: string; data?: unknown };
}

function parseEvent(chunk: string): SseEvent | null {
  let event = 'message';
  const dataLines: string[] = [];

  for (const line of chunk.split('\n')) {
    if (line === '' || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const field = line.slice(0, colon);
    const value = line.slice(colon + 1).replace(/^ /, '');
    if (field === 'event') event = value;
    else if (field === 'data') dataLines.push(value);
  }

  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join('\n') };
}

class SseReader {
  private buffer = '';
  private readonly queue: SseEvent[] = [];
  private readonly waiters: Array<(event: SseEvent) => void> = [];
  private closed = false;

  constructor(reader: ReadableStreamDefaultReader<Uint8Array>) {
    void this.pump(reader);
  }

  private async pump(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        this.buffer += decoder.decode(value, { stream: true });
        this.drain();
      }
    } catch {
      // 主动断开时 read 会抛错，按连接关闭处理
    } finally {
      this.closed = true;
    }
  }

  private drain(): void {
    for (;;) {
      const index = this.buffer.indexOf('\n\n');
      if (index === -1) return;
      const chunk = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 2);
      const event = parseEvent(chunk);
      if (!event) continue;
      const waiter = this.waiters.shift();
      if (waiter) waiter(event);
      else this.queue.push(event);
    }
  }

  /** 取下一个事件，跳过多余的心跳等非 message 事件 */
  async nextMessage(timeoutMs = 5000): Promise<SseEvent> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const queued = this.queue.shift();
      if (queued) {
        if (queued.event === 'message') return queued;
        continue;
      }
      if (this.closed) throw new Error('SSE 连接已关闭');
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('等待 SSE 消息超时');
      const next = await this.waitForEvent(remaining);
      if (next.event === 'message') return next;
    }
  }

  /** 取建连后的第一条事件（endpoint） */
  async nextEvent(timeoutMs = 5000): Promise<SseEvent> {
    const queued = this.queue.shift();
    if (queued) return queued;
    return this.waitForEvent(timeoutMs);
  }

  private waitForEvent(timeoutMs: number): Promise<SseEvent> {
    return new Promise((resolve, reject) => {
      const waiter = (event: SseEvent): void => {
        clearTimeout(timer);
        resolve(event);
      };
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error('等待 SSE 事件超时'));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }
}

export class McpTestClient {
  private nextId = 1;

  private constructor(
    private readonly endpoint: string,
    private readonly sse: SseReader,
    private readonly controller: AbortController,
    private readonly headers: Record<string, string>,
  ) {}

  /** 建立 SSE 连接，返回已经拿到 endpoint 的客户端 */
  static async connect(baseUrl: string, headers: Record<string, string> = {}): Promise<McpTestClient> {
    const controller = new AbortController();
    const response = await fetch(`${baseUrl}/mcp`, {
      headers: { accept: 'text/event-stream', ...headers },
      signal: controller.signal,
    });
    assert.equal(response.status, 200, 'GET /mcp 应返回 200');
    assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/, '应返回 SSE 流');
    assert.ok(response.body, 'SSE 响应应有 body');

    const sse = new SseReader(response.body.getReader());
    const first = await sse.nextEvent();
    assert.equal(first.event, 'endpoint', '建连后第一条事件应是 endpoint');
    assert.ok(first.data.includes('/mcp/message'), 'endpoint 应指向 /mcp/message');

    const endpoint = new URL(first.data, baseUrl).toString();
    return new McpTestClient(endpoint, sse, controller, headers);
  }

  /** 发送 JSON-RPC 请求并等待 SSE 上对应的响应；extraHeaders 可覆盖单次调用的设备头 */
  async request(method: string, params?: unknown, extraHeaders: Record<string, string> = {}): Promise<JsonRpcResponse> {
    const id = this.nextId++;
    await this.post({ jsonrpc: '2.0', id, method, params }, extraHeaders);
    const event = await this.sse.nextMessage();
    const payload = JSON.parse(event.data) as JsonRpcResponse;
    assert.equal(payload.id, id, `响应 id 应与请求一致（method=${method}）`);
    return payload;
  }

  /** 发送 JSON-RPC 通知，不等待响应 */
  async notify(method: string, params?: unknown): Promise<void> {
    await this.post({ jsonrpc: '2.0', method, params });
  }

  private async post(body: unknown, extraHeaders: Record<string, string> = {}): Promise<void> {
    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...this.headers,
        ...extraHeaders,
      },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 202, 'POST /mcp/message 应返回 202');
  }

  close(): void {
    this.controller.abort();
  }
}
