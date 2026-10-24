# 沙箱：灵犀设备模拟器

本机跑一个「假灵犀平台」：浏览器页面扮演灵犀硬件的输入端（语音/文字），把玩家原话通过 **MCP** 发给游戏服务；再把服务端返回的播报念出来。游戏局面由服务端经**长连接**只读同步到页面。

做这个沙箱的原因：

- 真机联调依赖控制台和实体硬件，Agent 没法自己跑、自己改；
- 沙箱让 Agent 可以纯脚本驱动整条链路（HTTP/CLI），改完就能验证；
- 同一台电脑开多个窗口就是多个玩家，双人对局不用两台设备。

## 架构

```
                    ┌───────────────────────────────┐
   手机 / 浏览器窗口  │  sandbox 页面（每窗口一个玩家）  │
   同一个内网都能开   │  语音/文字输入 · 播报 · 局面面板  │
                    └───────┬───────────────┬───────┘
             POST /api/say  │               │  SSE /events（只读）
                            ▼               ▼
                    ┌───────────────┐   ┌────────────────────┐
                    │ sandbox 服务   │   │ 游戏服务 :8000      │
                    │ 静态页 + 代理  │──▶│ MCP /mcp · /events │
                    └───────┬───────┘   └────────────────────┘
                            │ MCP JSON-RPC（X-Linx-* 身份头）
                            └──────────────▶ game_say(玩家原话)
```

- **所有意图判断都在游戏服务**：沙箱只把原话原样塞进 `game_say`，不认招式、不认「战况/怎么玩」。
- **MCP 只承担「平台把指令交给服务端」**：和真机上平台侧模型调用工具是同一个协议、同一组身份头。
- **页面只读同步局面**：唯一的输入路径是语音/文字对话，按钮只能把说法填进输入框，不能绕过对话直接调接口。

## 启动

```bash
pnpm dev            # 终端 1：游戏服务，0.0.0.0:8000
pnpm sandbox        # 终端 2：沙箱，0.0.0.0:8100
```

打开 `http://127.0.0.1:8100`。手机等同一内网设备访问终端打印的局域网地址（`http://<内网IP>:8100`）。

## 多窗口多人

每个窗口是一个独立玩家，身份规则：

| 打开方式 | 玩家身份 |
| --- | --- |
| `http://<host>:8100/?player=1` | `web-1` |
| `http://<host>:8100/?player=alice` | `web-alice` |
| 不带参数 | 每个标签页生成自己的 `web-xxxx`（存在 sessionStorage，刷新不变） |

`?player=` 只允许字母、数字、`-`、`_`，最长 16 位。页面上有「＋ 新窗口」按钮，直接开下一个空位。

双人流程（同一台电脑两个窗口，或两台设备）：

1. 窗口 A：说「开房间」→ 页面显示四位房间号；
2. 窗口 B：说「加入房间1234」（页面提供复制房间号的按钮）；
3. 两个窗口各自看到自己视角的气血、真气与轮次。

一方出招后，另一方的应对在自己的回合结算，出手方当场听不到结果。服务端会在出手方**下一次开口**时先补一句「刚才那一手。你一记强攻，对手格挡，掉3点气血，剩15。」，再播当前这一回合——补过一次不重复。网页端另有局面面板，随时能看到。

> 注意：浏览器「复制标签页」会把 sessionStorage 一起复制过去，两个标签页会变成同一个玩家。要多开请用页面上的「＋ 新窗口」或带 `?player=` 的地址。

## Agent 自主模拟

不经过浏览器也能驱动整条链路（这是给自动化调试用的输入通道）：

```bash
# 一个玩家说一句话，打印播报与当前局面
pnpm sandbox:say --device web-p1 "开房间"
pnpm sandbox:say --device web-p2 "加入房间1234"
pnpm sandbox:say --device web-p1 "强攻"

# 只看局面（JSON）
pnpm sandbox:state --device web-p1

# 看服务端暴露的 MCP 工具
pnpm sandbox:tools

# 一条命令把整局打完：开房、加入、轮流出招，顺带校验双方视角是否镜像
pnpm sandbox:selfplay --rounds 3

# 每一步都记下原话、播报与双方状态，--json 导出后可以写复盘
pnpm sandbox:selfplay --rounds 6 --json
```

跑出来的对局样例见 [`test-cases.md`](./test-cases.md)：3 局真实对局，逐轮记录双方原话、听到的播报与局面变化。

HTTP 接口同理（`curl` 可用）：

```bash
curl -s localhost:8100/api/say -H 'content-type: application/json' \
  -d '{"deviceId":"web-p1","text":"战况如何"}'
```

## 接口契约

页面只依赖下面这些接口，服务端字段变化时这里必须同步。

### GET /api/config

页面加载时读一次，拿地址与身份默认值。

```json
{
  "ok": true,
  "sandbox": "linx-sandbox",
  "version": "0.1.0",
  "upstream": "http://127.0.0.1:8000",
  "eventsUrl": "http://10.30.222.30:8000/events",
  "agentId": "linx-sandbox",
  "defaultDeviceId": "web-7f3a",
  "voice": { "lang": "zh-CN" }
}
```

- `eventsUrl` 是页面直接连游戏服务的状态流地址（按访问页面的 Host 推导，端口取 `upstream` 的端口）。
- 页面是 HTTPS 而服务端是 HTTP 时，`eventsUrl` 会退化成同源代理 `/api/events`（浏览器不允许混合内容）。
- `defaultDeviceId` 只在页面没带 `?player=` 且 sessionStorage 里也没有身份时用一次。

### POST /api/say

```json
{ "deviceId": "web-p1", "text": "强攻" }
```

```json
{
  "ok": true,
  "reply": "你一记强攻，对手格挡，掉2点气血，剩15。",
  "isError": false,
  "tool": "game_say",
  "deviceId": "web-p1",
  "agentId": "linx-sandbox",
  "sessionId": "s-2f8c1a",
  "state": { "battle": { "...": "同 SSE 快照" } },
  "trace": {
    "ms": 35,
    "requests": [
      {
        "method": "tools/call",
        "tool": "game_say",
        "status": 200,
        "ms": 18,
        "request": { "jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": { "name": "game_say", "arguments": { "text": "强攻" } } },
        "response": { "jsonrpc": "2.0", "id": 2, "result": { "content": [{ "type": "text", "text": "你一记强攻……" }] } }
      }
    ]
  }
}
```

- `reply` 就是工具返回的 `content[].text`，页面原样显示并朗读。
- `state` 是调用完成后从 `GET /state` 取到的局面快照；取不到时为 `null`（不影响播报）。
- 上游完全连不上：`{ "ok": false, "reply": "沙箱连不上游戏服务 http://…，先确认 pnpm dev 在跑。", "error": "upstream_unreachable" }`，HTTP 状态仍为 200，页面照常播报这句。

### GET /api/state?deviceId=web-p1

`{ "ok": true, "state": { ...同 SSE 快照 } }`

### GET /api/tools

`{ "ok": true, "tools": [{ "name": "game_say", "title": "…", "description": "…" }] }`

### GET /api/health

`{ "ok": true, "upstream": "http://127.0.0.1:8000", "reachable": true, "battles": 1, "rooms": 1 }`

### GET /api/events?device=web-p1&agent=linx-sandbox

SSE 代理，仅在页面 HTTPS + 服务端 HTTP 时使用，事件与游戏服务 `/events` 完全一致。

## 状态流（游戏服务 GET /events）

```
event: state
data: {"type":"state","device":"web-p1","agent":"linx-sandbox","revision":3,"updatedAt":1761284000000,"battle":{...}}
```

- 连接建立立刻推一次当前局面，之后只在局面变化时推；每 15 秒发一行注释 `: ping` 保活。
- 没有对局时 `battle: null`。
- `revision` 每条连接内自增，页面据此丢弃乱序。

`battle` 快照（已按当前玩家视角镜像，`player` 永远是你自己；`waiting` 只在双人房里对手还没加入时为 `true`）：

```json
{
  "room": "1234",
  "mode": "solo",
  "side": "player",
  "phase": "battle",
  "round": 2,
  "active": "player",
  "firstMover": "enemy",
  "pending": { "actor": "enemy", "move": "heavy", "moveLabel": "强攻", "damage": 5 },
  "waiting": false,
  "you": { "name": "你", "hp": 14, "maxHp": 14, "ap": 3, "maxAp": 5, "ultLeft": 1 },
  "opponent": { "name": "守擂教头", "hp": 15, "maxHp": 18, "ap": 2, "maxAp": 5, "ultLeft": 1 },
  "winner": null,
  "history": [
    {
      "round": 1,
      "actor": "player",
      "action": "light",
      "actionLabel": "普攻",
      "response": "guard",
      "responseLabel": "格挡",
      "damage": 1,
      "crit": false,
      "dodged": false,
      "guarded": true
    }
  ]
}
```

字段说明：

| 字段 | 含义 |
| --- | --- |
| `room` | 四位房间号；单人局为 `null` |
| `mode` | `solo`（AI 对手）/ `pvp`（房间内两位玩家） |
| `side` | 你在基准对局里坐哪边：`player` 房主 / `enemy` 加入者；快照已镜像，页面不用管 |
| `phase` | `battle` / `victory` / `defeat` |
| `active` | 现在轮到谁主动出招（视角内） |
| `pending` | 已锁定、等应对的攻击；`actor` 是「谁打出来的」，视角内 `player` 表示你已出手等对手 |
| `winner` | `player` / `enemy` / `null`，视角内 |
| `history` | 最近战报，最多 30 条；`actionLabel`/`responseLabel` 已是中文，直接显示 |
| `revision` | 快照版本，仅用于页面丢弃乱序事件 |

## 配置项

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `SANDBOX_PORT` | `8100` | 沙箱监听端口 |
| `SANDBOX_HOST` | `0.0.0.0` | 沙箱监听地址 |
| `SANDBOX_UPSTREAM` | `http://127.0.0.1:8000` | 游戏服务地址（MCP 与状态都走它） |
| `SANDBOX_AGENT_ID` | `linx-sandbox` | 冒充的智能体 ID，进 `X-Linx-Agent-Id` |
| `SANDBOX_EVENTS_URL` | 自动推导 | 强制指定页面用的状态流地址 |
| `SANDBOX_TLS_CERT` / `SANDBOX_TLS_KEY` | 空 | 配了就用 HTTPS 起服务（手机原生语音需要安全上下文） |
| `LOG_LEVEL` | `info` | 沙箱自己的日志级别 |

## 手机语音

浏览器只在**安全上下文**（HTTPS 或 localhost）里给麦克风，局域网纯 HTTP 页面拿不到 `SpeechRecognition`。沙箱页面会检测这一点并降级成文字输入，不会报错卡死。要真机语音，二选一：

1. 用 `mkcert` 给内网 IP 签证书，配 `SANDBOX_TLS_CERT`/`SANDBOX_TLS_KEY` 起 HTTPS（自签证书在手机上仍需信任一次）；
2. 用带证书的隧道（如 `cloudflared tunnel --url http://localhost:8100`）把页面挂到 HTTPS 域名下。

页面是 HTTPS 时，状态流要走同源代理（`/api/events`），沙箱会自动处理。

## 排障

| 现象 | 先看 |
| --- | --- |
| 页面显示「连不上沙箱」 | 沙箱进程是否在跑，端口是否被占 |
| 播报是「沙箱连不上游戏服务」 | `pnpm dev` 是否在跑，`SANDBOX_UPSTREAM` 是否指错 |
| 局面一直「等待局面」 | 打开调试面板看 `eventsUrl` 与 SSE 连接状态；服务端是否开了 CORS（`/events` 自带） |
| 两个窗口是同一个玩家 | 用了复制标签页；换 `?player=2` 或「＋ 新窗口」 |
| 手机点麦克风没反应 | 页面不是 HTTPS；看页面上的降级提示 |
