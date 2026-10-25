# MCP 接口（当前实现）

> 本文记录当前运行中的工具、HTTP 入口、身份头与返回格式。MCP v2 目标协议（两工具、事实 JSON）见 [协议设计](mcp-protocol.md)，迁移状态见 [实施说明](mcp-v2-migration.md)；本地联调与页面链路见 [沙箱说明](../testing/sandbox.md)。

## 工具

| 工具 | 玩家说法示例 | 入参 | 作用 |
| --- | --- | --- | --- |
| `game_say` | 任何一句原话 | `text`（1–120 字，原话不动）、`speaker`? | 默认入口：识别招式、战况、玩法、开局、发起挑战、接受挑战与规则外问答 |
| `game_start` | 「来一局」「共鸣对决，发起挑战」「接受挑战，编号1234」 | `opponent`?、`mode`=`solo`/`pvp`、`room`?、`text`?、`speaker`? | 开一局；`pvp` 发起挑战并拿到四位编号，`room` 接受挑战；会覆盖当前未结束的对局 |
| `game_action` | 「强攻」「躲开」「共鸣斩破军」 | `action`（招式 ID 或玩家原话）、`speaker`? | 主动：`light`/`heavy`/`ult`/`charge`；应对：`guard`/`dodge`/`take`；不合法不推进 |
| `game_status` | 「战况」「我还剩多少生命值」 | `speaker`? | 双方生命值、能量、大招次数、回合与当前该谁动 |
| `game_help` | 「怎么玩」「你能做什么」 | `speaker`? | 玩法与可用说法 |
| `wait_event` | 等对手时由 Agent 调用，没有玩家原话 | 无 | 把这次请求挂在服务端，等对手应招、对手进房时唤醒；轮到自己出招、单人局、无进行中对局或超时/取消时立刻返回 |

- 平台固定只调用 `game_say`，原话一字不改；其余五个工具是已有接入的兼容能力，其中 `wait_event` 只负责挂起等对手，不判断玩法。
- 所有工具都可带 `speaker`（不超过 20 字）。平台声纹命中时会填，只用于日志与称呼，不参与招式裁决和对局归属。
- `wait_event` 是第六个工具，但 v2 的两工具目标（`game_say` + `wait_event`、JSON 事实）仍未实现，不能按目标协议验收当前服务。挂起时长由 `WAIT_EVENT_TIMEOUT_MS` 控制，默认 30000 毫秒，夹在 1000～120000；唤醒、超时与平台取消都按同一返回外形给文本，挂起期间不占对局事务。

## HTTP 入口

| 方法与路径 | 用途 |
| --- | --- |
| `POST /mcp` | Streamable HTTP，平台当前实际使用 |
| `GET /mcp` 或 `GET /sse` | SSE 长连接，兼容平台早先文档 |
| `POST /mcp/message` | 在 SSE 会话里投递 JSON-RPC |
| `DELETE /mcp` | 结束 MCP 会话 |
| `GET /health` | 存活探针 |
| `GET /state` | 当前视角的局面快照，供调试与状态流复用，不推进对局 |
| `GET /events` | SSE 状态流：`state` 局面变化推送，`push` 主动提醒（对手进房/锁定招式、大招就绪、空闲催办），页面与手机只读消费 |
| `GET /admin` | 只读后台监控页；配置 `ADMIN_TOKEN` 后需要口令 |
| `GET /admin/api/rooms` | 监控页数据：房间为主，单人局单列 |
| `GET`/`POST /debug/*` | `state`、`start`、`action`、`status` 四个调试端点；由 `ENABLE_DEBUG_ENDPOINTS` 控制，生产环境关闭 |

`/state` 与 `/events` 的身份与工具调用一致：请求头或查询参数里的 `device`、`agent`、`session`、`display`。页面上的 `?player=1` 是沙箱自己的映射，不是游戏服务的参数。

## 身份与载体

| 来源 | 字段 | 用途 |
| --- | --- | --- |
| 请求头 | `X-Linx-Device-Id` | 设备 ID |
| 请求头 | `X-Linx-Agent-Id` | 智能体 ID |
| 请求头 | `X-Linx-Session-Id` | 会话 ID，每轮刷新 |
| 请求头 | `X-Linx-Display` | `screen` / `voice`；缺省按无屏终端处理，保留补账播报 |
| 请求头 | `X-Linx-Speaker-Name`、`X-Linx-Speaker-Id` | 声纹称呼与编号，只进日志 |
| 查询参数 | `device`、`agent`、`session`、`display` | 本地调试与页面兼容，平台用请求头 |

对局归属键按 `deviceId#agentId` → `session:<sessionId>` → `anon:<连接级 id>` 依次退化。同一台设备、同一个智能体的会话共享一局；会话 ID 每轮都变，不参与归属。

## 返回

成功时返回可朗读文本，并附带同一份事实：

```json
{
  "content": [{ "type": "text", "text": "我出强攻，接招！等对手应对。" }],
  "structuredContent": {
    "presentation": {
      "version": 1,
      "kind": "turn",
      "certainty": "confirmed",
      "facts": {
        "round": 2,
        "phase": "battle",
        "you": { "hp": 14, "energy": 1, "ultimateRemaining": 1 },
        "opponent": { "hp": 18, "energy": 3, "ultimateRemaining": 1 },
        "opponentName": "对手",
        "events": [],
        "next": "wait-response"
      },
      "renderings": ["我出强攻，接招！等对手应对。"]
    }
  }
}
```

- `content[].text` 是口语文本，当前兼容契约，可直接朗读。
- `structuredContent.presentation` 从真实状态与裁决生成：`facts` 给回合、阶段、双方资源、事件、下一步与确定性，`renderings` 是候选话术。沙箱表达层用它做保守校验与改写；平台是否会消费这个字段尚未验证。
- 业务拒绝走正常返回，`certainty` 为 `not-applied` 并给出原因，对局不推进。
- 工具内部异常返回 `isError: true`，文本提示「结果未确认，先核实战况」；不会把异常包装成成功。
- 日志记录工具名、对局键、说话人、入参摘要与返回文本，不记录密钥。

## 调试链路

```bash
pnpm dev                                  # 终端 1：启动游戏服务
pnpm smoke                                # 走一遍 initialize → tools/list → tools/call
pnpm sandbox:tools                        # 查看沙箱实际拿到的工具清单
pnpm sandbox:say --device web-p1 "强攻"   # 以指定身份说一句，观察播报与局面
```

完整工具参数、错误码与真机抓包口径以 [沙箱说明](../testing/sandbox.md) 与实现为准；平台侧配置步骤见 [接入灵犀平台](linx-integration.md)。
