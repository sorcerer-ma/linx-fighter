# MCP 接口（当前实现）

> 服务已实现 v2 事实协议：只注册 `game_say` 与 `wait_event`，工具返回单行 JSON。完整字段、枚举与配套提示词见 [协议设计](mcp-protocol.md)，迁移记录见 [实施说明](mcp-v2-migration.md)；本地联调与页面链路见[沙箱说明](../testing/sandbox.md)。

## 工具

| 工具 | 玩家说法 | 入参 | 作用 |
| --- | --- | --- | --- |
| `game_say` | 任何一句原话 | `text`（1–200 字，原话不动）、`speaker`? | 唯一输入入口：识别招式、战况、玩法、开局、发起挑战、接受挑战与规则外问答，返回 v2 事实 |
| `wait_event` | 不需要玩家原话 | `speaker`? | 把这次请求挂在服务端，等对手进房或出招；轮到自己出招、对手已出招等自己应招、单人局、无进行中对局或对局已结束时立刻返回 |

- 平台固定只调用 `game_say`；`need` 为 `wait_guest` 或 `wait_foe` 时，先播完即时话术，再按 need 串行持续调用 `wait_event`。旧 `game_start`、`game_action`、`game_status`、`game_help` 不再注册。
- 两个工具都只带本次平台声纹元数据 `speaker`（≤20 字）。配置 `ALLOWED_SPEAKERS` 后未登记的说话人静默；参数与 `X-Linx-Speaker-Name` 冲突时静默，不沿用旧身份。`speaker` 不参与招式裁决与对局归属。
- `text` 为空或超过 200 字返回 `ok:false/reason:"unclear"`，不截断、不执行。工具不自行分类、归一化或补上下文。
- 挂起上限由 `WAIT_EVENT_TIMEOUT_MS` 控制（默认 290000，即 290 秒，夹在 1000～300000 毫秒），沙箱wait工具传输预算300秒、页面外层315秒；唤醒、超时与平台取消返回同一外形，挂起期间不占对局事务。
- 返回的 `content` 只有一条 `text` 块，`_meta["linx/battleId"]` 是对局 id（没有对局时为 `null`）。

## HTTP 入口

| 方法与路径 | 用途 |
| --- | --- |
| `POST /mcp` | Streamable HTTP，平台当前实际使用 |
| `GET /mcp` 或 `GET /sse` | SSE 长连接，兼容平台早先文档 |
| `POST /mcp/message` | 在 SSE 会话里投递 JSON-RPC |
| `DELETE /mcp` | 结束 MCP 会话 |
| `GET /health` | 存活探针 |
| `GET /state` | 当前视角的局面快照，供沙箱 CLI、调试脚本与状态流代理使用，不推进对局 |
| `GET /events` | SSE 状态流：`state` 局面变化推送，`push` 主动提醒信号；页面只读消费 |
| `POST /notification` | 页面确认一条 `push` 后回传 `pushId`/`battleId`/`kind`；服务端核对身份、对局、一次性 id 与局面指纹，返回同形 v2 reply，不重放旧提醒 |
| `GET /admin` | 只读后台监控页；配置 `ADMIN_TOKEN` 后需要口令 |
| `GET /admin/api/rooms` | 监控页数据：房间为主，单人局单列 |
| `GET`/`POST /debug/*` | `state`、`start`、`action`、`status` 四个调试端点；由 `ENABLE_DEBUG_ENDPOINTS` 控制，生产环境关闭 |

`/state`、`/events` 与工具调用共用身份解析：请求头或查询参数里的 `device`、`agent`、`session`、`display`。页面上的 `?player=1` 是沙箱自己的映射，不是游戏服务的参数。

## 身份与载体

| 来源 | 字段 | 用途 |
| --- | --- | --- |
| 请求头 | `X-Linx-Device-Id` | 设备 ID |
| 请求头 | `X-Linx-Agent-Id` | 智能体 ID |
| 请求头 | `X-Linx-Session-Id` | 会话 ID，每轮刷新 |
| 请求头 | `X-Linx-Display` | `screen` / `voice`；缺省按无屏终端处理，只影响旧内部文本的补账 |
| 请求头 | `X-Linx-Speaker-Name`、`X-Linx-Speaker-Id` | 声纹称呼与编号，用于白名单与日志 |
| 查询参数 | `device`、`agent`、`session`、`display` | 本地调试与页面兼容，平台用请求头 |

对局归属键按 `deviceId#agentId` → `session:<sessionId>` → `anon:<连接级 id>` 依次退化。同一台设备、同一个智能体的会话共享一局；会话 ID 每轮都变，不参与归属。

## 返回

成功时 `content[].text` 是一行紧凑 JSON：

```json
{"v":2,"ok":true,"phase":"battle","need":"move","mode":"solo","round":2,"you":{"hp":14,"maxHp":14,"ap":3,"maxAp":5,"ult":1},"foe":{"name":"对手","hp":18,"maxHp":18,"ap":2,"maxAp":5,"ult":1},"events":[{"t":"hit","by":"you","mv":"light","r":"guard","dmg":1}],"choices":["普攻","强攻","蓄力"]}
```

- 常用字段：`v`（固定 `2`）、`ok`、`silent`、`phase`、`need`、`mode`、`room`、`round`、`you`/`foe` 双方生命值与能量、`pending`、`choices`、`deny`、`events`、`text`、`say`、`reason`。
- `need` 取 `move` / `respond` / `wait_guest` / `wait_foe` / `none`；`choices` 只列当前真正可出的合法动作；`deny.need` 与 `deny.short` 说明能量缺口。
- `events` 只保留已结算事实：`start`、`room`/`join`、`round`、`charge`、`hit`、`end`、`timeout`、`chant`。`pending` 只表示已锁定攻击，不是最终结果。
- 文本块固定一行、不超过 16 KB；完整事实不截断、不拼半截 JSON，也不依赖 `structuredContent`。
- 业务拒绝走 `ok:false` + `reason`（`unclear`、`negated`、`ambiguous`、`wrong_stage`、`no_ap`、`no_ult`、`waiting`、`ended`、`room_missing`、`room_full`、`room_bad`、`failed`、`unknown` 等），对局不推进。只有 `failed` 能说确定未执行；`unknown` 或工具异常先核实战况，不自动重做。
- 完全静默返回 `{"v":2,"ok":true,"silent":true}`，不生成话术、不触发 TTS。
- `text` / `say` 是旧链路的人话兼容字段：`text` 为特殊原文，`say` 为平实兜底；Agent 应优先依据事实演绎，不能把 JSON 直接朗读。
- 工具内部异常返回 `isError: true`，文本为 `ok:false/reason:"unknown"`；不会把异常包装成成功。

## 调试链路

```bash
pnpm dev                                  # 终端 1：启动游戏服务
pnpm smoke                                # 走一遍 initialize → tools/list → tools/call
pnpm sandbox:tools                        # 查看沙箱实际拿到的工具清单
pnpm sandbox:say --device web-p1 "强攻"   # 以指定身份说一句，观察事实与局面
```

真实平台是否已订阅两工具、是否把 `content` 依次下发、长请求能挂多久，都必须看平台配置与真机日志；仓库测试与沙箱通过不等于平台已验收。平台侧配置步骤见[接入灵犀平台](linx-integration.md)。
