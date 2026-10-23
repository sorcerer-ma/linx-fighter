# 灵犀对决（linx-fighter）

灵犀（七牛 Xrobot 语音硬件）上的回合制语音对战游戏服务端：玩家用语音下令，角色按招式出招，通过策略与游戏机制对手对决。

服务通过 **MCP 协议**接入灵犀平台，由平台侧智能体调用工具推进对局。同时支持 Streamable HTTP（`POST /mcp`，平台实测走的是这条）与 SSE（`GET /mcp` + `POST /mcp/message`）两种传输。

> 当前阶段：**框架**。MCP 链路、对局状态管理、播报文案都已打通；命中判定、伤害公式、胜负判定等玩法机制尚未接入，见 [docs/game-design.md](docs/game-design.md)。

## 现在能做什么

| 工具 | 触发场景 | 说明 |
| --- | --- | --- |
| `game_start` | 玩家说「开始游戏」「来一局」 | 开一局新对局，覆盖未结束的旧对局 |
| `game_action` | 玩家说出攻击 / 闪避 / 回气 | 识别口语招式，推进一个回合，返回播报 |
| `game_status` | 玩家问「战况如何」「我还剩多少血」 | 播报双方气血、真气与回合数 |
| `game_help` | 玩家问「怎么玩」 | 播报玩法说明 |

- 招式识别兼容口语：攻击 / 打 / 砍、闪避 / 躲开 / 防御、回气 / 调息 / 蓄气 等（见 `src/game/actions.ts`）。
- 认不出招式时**不消耗回合**，只提示可选招式。
- 没有对局时直接出招会**自动开局**，首句「攻击」也能玩。
- 对局按「设备 + 智能体」归属，玩家断线重连、换一轮对话都不会丢。

## 快速开始

```bash
pnpm install
pnpm dev          # 开发模式，改动自动重启，默认 0.0.0.0:8000
pnpm test         # 单元测试 + MCP 端到端测试
pnpm demo         # 不连 MCP，直接看每个指令的播报
pnpm build        # 编译到 dist/
pnpm start        # 运行编译产物
```

连上服务后可以先跑一遍真实调用链（需要服务已启动）：

```bash
pnpm exec tsx scripts/smoke.ts http://127.0.0.1:8000
```

输出会依次打印 `initialize`、`tools/list`、以及开局 / 出招 / 战况 / 说明的播报文本。

## MCP 接口

| 端点 | 方法 | 用途 |
| --- | --- | --- |
| `/mcp` | POST | Streamable HTTP：直接收发 JSON-RPC，响应为 JSON |
| `/mcp`、`/sse` | GET | 建立 SSE 长连接，服务端先推 `endpoint` 事件，给出 POST 地址 |
| `/mcp/message?sessionId=<id>` | POST | 老式 SSE 通道：接收 JSON-RPC，响应从 SSE 流返回 |
| `/health` | GET | 健康检查 |

平台在每次调用时通过 HTTP 头带设备信息（不放进工具入参）：

| 请求头 | 含义 |
| --- | --- |
| `X-Linx-Device-Id` | 设备 ID，对局归属的主要依据 |
| `X-Linx-Agent-Id` | 智能体 ID，同一设备换智能体就是另一局 |
| `X-Linx-Session-Id` | 会话 ID，每轮对话刷新 |

工具返回形如：

```json
{
  "content": [{ "type": "text", "text": "第 1 回合，你出了「攻击」。……" }],
  "isError": false
}
```

`text` 就是平台侧模型念给玩家的话，所以文案是口语化的中文，且做了长度控制。

## 配置

全部来自环境变量，参考 `.env.example`：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8000` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error`，日志为单行 JSON |
| `BATTLE_TTL_SECONDS` | `1800` | 对局空闲过期时间 |
| `ENABLE_DEBUG_ENDPOINTS` | 非生产环境开启 | 是否暴露 `/debug/*` 调试接口 |

## 目录结构

```
src/
  index.ts            启动入口：装配依赖、监听端口、优雅退出
  config.ts           环境变量解析
  log.ts              单行 JSON 日志
  game/
    types.ts          数据模型：Fighter / Battle / TurnRecord / ActionResult
    actions.ts        招式定义与口语识别
    engine.ts         创建对局、回合结算（玩法机制接入点）
    narrator.ts       播报文案
    service.ts        游戏编排：开局 / 出招 / 战况 / 说明
  mcp/
    context.ts        设备上下文与对局归属键
    server.ts         McpServer 创建与 instructions
    tools.ts          工具注册
  http/app.ts         路由：Streamable HTTP / SSE、健康检查、调试接口
  store/battles.ts    对局存储（当前为内存 + TTL）
docs/
  architecture.md     架构与设计决策
  game-design.md      玩法机制（待补）与接入点
  linx-integration.md 灵犀平台接入步骤与智能体提示词
test/                 单元测试 + MCP 协议端到端测试
```

## 部署

服务跑在七牛云内网机器 `100.100.61.41`（`linx-fighter.service`，用户 `linx`，代码在 `/opt/linx-fighter`）。内网地址 `http://100.100.61.41:8000/mcp` 平台访问不到，另用 `linx-tunnel.service`（bore 内网穿透）暴露到公网，控制台填 **`http://bore.pub:3216/mcp`**。

```bash
systemctl status linx-fighter     # 应用状态
journalctl -u linx-fighter -f     # 实时日志
systemctl status linx-tunnel      # 隧道状态（实际端口见 journalctl -u linx-tunnel）
scripts/deploy.sh                 # 编译 + 同步 + 重启 + 自检
```

也可以用 Docker：

```bash
docker build -t linx-fighter .
docker run -d --name linx-fighter -p 8000:8000 linx-fighter
```

反向代理 / 隧道务必关闭对 SSE 的缓冲（配置见 [docs/linx-integration.md](docs/linx-integration.md)）。

## 接入灵犀平台

操作步骤、自检方法与可直接粘贴的智能体提示词都在 [docs/linx-integration.md](docs/linx-integration.md)。

## 下一步

1. 补玩法机制：命中/闪避判定、伤害与回气公式、对手策略、胜负结算（`src/game/engine.ts` 的 `resolveTurn`）。
2. 数值平衡与播报打磨。
3. 如需多实例部署或重启保留对局，把 `BattleStore` 换成 Redis 实现。
4. 可选：对局结束、关键回合用 `linx_play` 播放音效（返回 `structuredContent` 触发设备动作）。
