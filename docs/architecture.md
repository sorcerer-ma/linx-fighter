# 架构与设计决策

## 请求链路

```
玩家语音
  → 灵犀设备
  → 灵犀平台（意图识别 + 带 Function Call 的模型）
  → MCP 客户端：POST /mcp 直接发 JSON-RPC（Streamable HTTP）
  → 本服务 tools.ts / http/app.ts
  → GameService → engine.ts（结算）+ enemy.ts（AI）+ pvp.ts（双人视角）+ narrator.ts（播报）
  → 工具返回 text
  → 平台模型把 text 念给玩家
```

关键点：**服务端是对局的唯一事实来源**。平台侧模型只负责理解玩家意图、调用工具、朗读结果，不做数值推演；这样换模型、换提示词都不会影响对局正确性。

## 分层职责

| 层 | 文件 | 职责 |
| --- | --- | --- |
| 接入层 | `src/http/app.ts` | 两种 MCP 传输（Streamable HTTP / SSE）、设备上下文提取、调试接口 |
| 协议层 | `src/mcp/server.ts`、`src/mcp/tools.ts` | MCP Server 创建、工具注册与参数校验、异常兜底 |
| 编排层 | `src/game/service.ts` | 开局 / 出招 / 战况 / 说明，单人/双人分流，读改写存储 |
| 规则层 | `src/game/engine.ts`、`src/game/rules.ts` | 回合结算与全部数值，纯函数、随机数由 seed 派生 |
| 策略层 | `src/game/enemy.ts` | AI 对手的决策模型，只读公开视角、不掷随机数 |
| 联机层 | `src/game/pvp.ts` | 房间号、双人视角镜像与写回 |
| 表现层 | `src/game/narrator.ts` | 播报文案，只依赖对局状态与事件 |
| 存储层 | `src/store/battles.ts`、`src/store/rooms.ts` | 对局与房间的读写、过期清理 |

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

### 5. 随机数全部由对局 seed 派生

`engine.resolveTurn` 保持纯函数，暴击/闪避的随机数来自 `battle.seed` 的计数器（`rng.ts`），不散用 `Math.random`。这样同一 seed 能逐位复现，仿真对拍才有意义：`pnpm validate` 用 CPython 同款 MT19937 重跑 256,000 局，任何结算顺序或数值漂移都会报错。

### 6. 双人联机用「视角镜像」而不复制一套引擎

`Battle` 内部以 `mode: 'solo' | 'pvp'` 区分是否跑 AI。双人模式下，每个玩家读到的都是自己的视角（`pvp.viewAs` 把 `player`/`enemy` 互换），写回时再换回基准视角（`canonicalize`）。引擎结算逻辑只有一份，房间号与「对局键 → 房间」索引放在 `RoomStore`。

### 7. AI 是决策模型，不是随机权重

对手按「能斩杀优先、保大招、血线安全时攒气、否则先避免致死再最小期望伤害」做效用打分（`docs/ai-enemy.md`）。它不掷随机数，所有随机性只来自引擎，因此 AI 变化不会破坏对拍。

### 8. 认不出招式不消耗回合

语音识别错误很常见（「攻击」被识别成「公鸡」）。此时推进回合会让玩家莫名掉血/掉气，体验很差；正确的做法是提示可选招式、保持状态不变，让玩家重说一遍。

### 9. 没有对局时直接出招自动开局

玩家第一句往往就是「攻击」而不是「开始游戏」。自动开局避免了一次无意义的往返，播报里会说明「先给你开了一局」。

### 10. 每个 SSE 连接一个 McpServer 实例

`McpServer` 内部保存每个连接的协议状态（初始化、能力协商），多连接共用一个实例会串会话。所以 `createMcpServer()` 在 `GET /mcp` 里按连接创建。

### 12. JEV：意图归一化与对手决策

意图模型（`src/game/intent.ts`）接在 `matchAction` 之后：规则认不出、且轮到该玩家时，才把原话和当前阶段发给 OpenRouter 的 decisions 接口（`POST /api/alpha/decisions`），把「这句话对应哪一招」表达成一个 choice 选择题，选项按阶段限定。模型返回选择与概率，置信度 ≥ 0.6 才采纳；它不产出数值、不改对局状态；超时 1.5 秒、HTTP 异常、返回越界都回退为「没听出来」，因此断网也能玩。未配 `OPENROUTER_API_KEY` 时整层不启用。

对手的每次出招与应对也走 JEV（`src/game/enemy-jev.ts`）：本地先按真气与大招次数过滤出合法选项，把「当前局面 → 选哪个」做成选择题；模型只能从合法选项里选，超时 1.2 秒、HTTP 异常、选项越界都回退 `ENEMY_AI`，置信度与概率只写日志。模型只选动作，数值与胜负仍只在 engine 算。因为要等模型返回，`resolveTurn` / `advanceBattle` 是 async，但仍不改入参、返回新状态；同一 seed 不再保证复现，单测与 256,000 局对拍都注入本地 AI，不受影响。`ENEMY_AI=local` 可关闭这层。

### 11. 错误不外抛

工具内部异常统一转成 `isError: true` + 一句玩家能听懂的提示，并记 error 日志。协议层保持 202 正常返回，避免平台侧模型拿到看不懂的协议错误后乱编结果。

## 扩展指引

- **加招式**：在 `types.ts` 的 `ActionId` 加枚举，在 `actions.ts` 加 `ActionMeta`（含中文名、口语别名、ASR 误识别与唤出指令），工具参数无需改动；数值加到 `rules.ts`，结算逻辑在 `engine.ts`，并补 `test/actions.test.ts` 与仿真对拍。
- **调数值**：只改 `src/game/rules.ts`，同步 `docs/game-design.md` 与 `test/fixtures/v02-validation.json`（跑 `pnpm validate` 会告诉你哪项漂了）。
- **加属性**（如护甲、连击数）：加在 `Fighter`，同步 `narrator.ts` 的播报、`engine.ts` 的初始值，并确认 `pvp.swapSides` 仍然成立。
- **换存储**：实现与 `BattleStore` 相同的 `get` / `set` / `delete` / `sweep` / `size`，在 `index.ts` 替换构造即可。
- **多实例部署**：除了换 Redis 存储，还要注意 SSE 连接与 POST 必须落到同一实例（会话粘滞），否则 POST 找不到本地 transport。若做无状态部署，需要把会话注册表也放进共享存储。
- **可观测性**：所有关键动作（连接建立/关闭、开局、出招、工具失败）都有结构化日志，接日志采集时按 `message` 字段建索引。
