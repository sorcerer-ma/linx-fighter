# 架构与设计决策

## 请求链路

```
玩家语音
  → 灵犀设备
  → 灵犀平台（意图识别 + 带 Function Call 的模型）
  → MCP 客户端：POST /mcp 直接发 JSON-RPC（Streamable HTTP）
  → 本服务 tools.ts / http/app.ts
  → GameService → engine.ts（结算）+ narrator.ts（播报）
  → 工具返回 text
  → 平台模型把 text 念给玩家
```

关键点：**服务端是对局的唯一事实来源**。平台侧模型只负责理解玩家意图、调用工具、朗读结果，不做数值推演；这样换模型、换提示词都不会影响对局正确性。

## 分层职责

| 层 | 文件 | 职责 |
| --- | --- | --- |
| 接入层 | `src/http/app.ts` | 两种 MCP 传输（Streamable HTTP / SSE）、设备上下文提取、调试接口 |
| 协议层 | `src/mcp/server.ts`、`src/mcp/tools.ts` | MCP Server 创建、工具注册与参数校验、异常兜底 |
| 编排层 | `src/game/service.ts` | 开局 / 出招 / 战况 / 说明的业务流程，读改写存储 |
| 规则层 | `src/game/engine.ts`、`src/game/actions.ts` | 招式定义、回合结算（待补玩法） |
| 表现层 | `src/game/narrator.ts` | 播报文案，只依赖对局状态 |
| 存储层 | `src/store/battles.ts` | 对局读写与过期清理 |

依赖方向自上而下，规则层不感知 MCP，因此可以用 `scripts/demo.ts` 脱离协议直接跑玩法。

## 设计决策

### 1. 同时支持 Streamable HTTP 与 SSE

平台文档描述的是 SSE（`GET /mcp` 建长连接 + `POST /mcp/message` 发 JSON-RPC），最初的实现只做了这一套。但联调时日志显示平台实际打过来的是 `POST /mcp` + `application/json`，直接发 JSON-RPC、没有 GET 建连，属于新版的 Streamable HTTP 传输，服务端返回 404，设备侧就报「服务器出错」。

所以两套传输都保留，按方法分流，互不影响：

| 请求 | 传输 | 处理方式 |
| --- | --- | --- |
| `POST /mcp` | Streamable HTTP | 无状态：每个请求建一个临时 `McpServer` + `StreamableHTTPServerTransport`，请求结束即释放，响应为普通 JSON |
| `GET /mcp`（或 `/sse`） | SSE | 有状态：一个连接一个会话，先推 `endpoint` 事件给出 POST 地址 |
| `POST /mcp/message` | SSE | 把 JSON-RPC 交给对应 SSE 会话，响应从 SSE 通道返回 |

两种传输共用同一份对局存储，因此「先 POST 建对局、再用另一种传输继续出招」也能接上。平台控制台里填 `https://<域名>/mcp` 即可，不依赖地址后缀是不是 `/sse`。

### 2. 对局归属键 = 设备 ID + 智能体 ID

平台每轮对话会给新的 `X-Linx-Session-Id`，如果按会话存对局，玩家换个话题回来就「失忆」了。所以：

- 有设备 ID：`<deviceId>#<agentId>`，断线重连、重开对话都能接上；
- 没有设备 ID 但有会话 ID：退化为 `session:<sessionId>`；
- 都没有：`anon:<连接级 UUID>`，只用于本地手工调试。

GET 建连时平台可能还没带设备头，POST 调用一定带，所以上下文在每次 POST 时刷新（`applyRequestContext`），已拿到的值不会被空值覆盖。

### 3. 存储先用内存，接口保持可替换

`BattleStore` 是一个 Map + 写入时顺带清理过期对局（不额外起定时器）。单实例部署足够；多实例或重启保留对局时，换 Redis 实现即可，`GameService` 不用改。

### 4. 工具返回纯文本，不返回 structuredContent

框架阶段没有设备动作（音效、换角色）的需求。返回纯文本对平台侧模型最稳，不需要它理解额外结构。以后要播报音效，再按平台文档在 `structuredContent.funcs` 里下发 `linx_play`，工具的 `content.text` 保持不变即可。

### 5. 认不出招式不消耗回合

语音识别错误很常见（「攻击」被识别成「公鸡」）。此时推进回合会让玩家莫名掉血/掉气，体验很差；正确的做法是提示可选招式、保持状态不变，让玩家重说一遍。

### 6. 没有对局时直接出招自动开局

玩家第一句往往就是「攻击」而不是「开始游戏」。自动开局避免了一次无意义的往返，播报里会说明「先给你开了一局」。

### 7. 每个 SSE 连接一个 McpServer 实例

`McpServer` 内部保存每个连接的协议状态（初始化、能力协商），多连接共用一个实例会串会话。所以 `createMcpServer()` 在 `GET /mcp` 里按连接创建。

### 8. 错误不外抛

工具内部异常统一转成 `isError: true` + 一句玩家能听懂的提示，并记 error 日志。协议层保持 202 正常返回，避免平台侧模型拿到看不懂的协议错误后乱编结果。

## 扩展指引

- **加招式**：在 `types.ts` 的 `ActionId` 加枚举，在 `actions.ts` 加 `ActionMeta`（含中文名与口语别名），工具参数无需改动；结算逻辑在 `engine.ts`。
- **加属性**（如护甲、连击数）：加在 `Fighter`，同步 `narrator.ts` 的播报与 `engine.ts` 的初始值。
- **换存储**：实现与 `BattleStore` 相同的 `get` / `set` / `delete` / `sweep` / `size`，在 `index.ts` 替换构造即可。
- **多实例部署**：除了换 Redis 存储，还要注意 SSE 连接与 POST 必须落到同一实例（会话粘滞），否则 POST 找不到本地 transport。若做无状态部署，需要把会话注册表也放进共享存储。
- **可观测性**：所有关键动作（连接建立/关闭、开局、出招、工具失败）都有结构化日志，接日志采集时按 `message` 字段建索引。
