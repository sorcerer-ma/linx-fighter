# 沙箱：灵犀设备模拟器

本机跑一个「假灵犀平台」：浏览器页面提供语音／文字输入，原话经 `/api/say` → MCP `game_say` 进入真实服务；本分支经 Agent 转发与可选表达后形成最终 reply，局面经长连接只读同步。已合并的 v2 协议尚未实现，未来由 Agent 依据事实形成最终话术，再交语音播放。迁移与验收见 [实施说明](../engineering/mcp-v2-migration.md)。

本分支已包含双视图、持续聆听、伙伴表达与提示词配置；这些文本兼容实现不代表 v2 已交付。ASR/TTS 适配层与 MCP 协议独立，不因语音替换而改变游戏裁决或重做行动。

做这个沙箱的原因：

- 真机联调依赖控制台和实体硬件，Agent 没法自己跑、自己改；
- 沙箱让 Agent 可以纯脚本驱动整条链路（HTTP/CLI），改完就能验证；
- 同一台电脑开多个窗口就是多个玩家，双人对局不用两台设备。


## 移动伙伴界面

沙箱页面改为同一本方伙伴设备的正背双视图：上方正面小屏展示表情、生命辅助条、五闪电能量和大招角标，下方背面只有外壳与灯。资源、阶段、战果与胜负均来自现有服务快照／裁决记录；初次载入与重复查询不重播历史动作，断线或行动结果未确认时不显示大招就绪。没有原型状态切换或模拟出招控件。默认收起的“对手状态 · 只读调试”区随同一状态流展示公开的对手生命值、能量、大招次数和当前阶段，不增加轮询或控制对手的操作；未加入、无对局和连接未确认时明确提示，不展示伪造默认值。

玩家识别文字与伙伴回复显示在设备视图之外。点击麦克风开启持续聆听，再点明确停止；浏览器单段结束或短静音后接续识别，不关闭用户的启用选择。浏览器实际开始识别后才显示收音，等待请求或伙伴朗读时暂停、结束后恢复；临时识别文字不表示服务已理解或接受，最终结果仅提交一次并仍走原有 `/api/say`。手动停止、页面切走、权限拒绝或不可恢复错误会终止会话，不自动无限重试。浏览器自身仍可能中断，真机持续收音需要验收。主界面保留必要麦克风及状态，不设开房／加入按钮或开始设置面板，开房加入沿用语音指令；识别不可用时显示原有文字输入降级。手机视口下麦克风、聆听状态与键盘输入收在同一条底部栏，页面滚动、对话变长和软键盘弹出时仍停在视口底部，不随内容移出屏幕；键盘按钮常驻，展开输入行即暂停识别，语音识别不可用（浏览器不支持或页面不是 HTTPS）时提示改用键盘并自动展开；新回复到达时把最新一条顶到底部栏上方，不需要手动下滑。TTS播放状态来自浏览器播放事件，朗读事件不回调时超时收尾并恢复聆听，避免一直停在等待状态；真机识别、朗读与同室对战仍需验收。

本分支不改变 `SANDBOX_DISPLAY` 默认值，命令路由、容错与归属沿用服务端实现；串音、静默回复与真实双端流程仍需按实际场景验收。


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
3. 两个窗口各自看到自己视角的生命值、能量与轮次。

一方出招后，另一方的应对在自己的回合结算，出手方当场听不到结果。服务端会在出手方**下一次开口**时先补一句「刚才那一手。我强攻，对手格挡，掉3点生命值，剩15。」，再播当前这一回合——补过一次不重复。网页端另有局面面板，随时能看到。

> 注意：浏览器「复制标签页」会把 sessionStorage 一起复制过去，两个标签页会变成同一个玩家。要多开请用页面上的「＋ 新窗口」或带 `?player=` 的地址。

## Agent 自主模拟

不经过浏览器也能驱动整条链路（这是给自动化调试用的输入通道）：

```bash
# 一个玩家说一句话，打印播报与当前局面
pnpm sandbox:say --device web-p1 "开房间"
pnpm sandbox:say --device web-p2 "加入房间1234"
pnpm sandbox:say --device web-p1 "强攻"
pnpm sandbox:say --device hw-1 --voice "强攻"   # 模拟无屏硬件：播报会补上错过的结算

# 只看局面（JSON）
pnpm sandbox:state --device web-p1

# 看服务端暴露的 MCP 工具
pnpm sandbox:tools

# 一条命令把整局打完：开房、加入、轮流出招，顺带校验双方视角是否镜像
pnpm sandbox:selfplay --rounds 3

# 每一步都记下原话、播报与双方状态，--json 导出后可以写复盘
pnpm sandbox:selfplay --rounds 6 --json

# 自对弈默认按无屏终端跑（播报里会出现「刚才那一手。」补账）；加 --screen 走网页那条不补账的路径
pnpm sandbox:selfplay --rounds 1 --screen
```

跑出来的对局样例见 [`test-cases.md`](sandbox-test-cases.md)：3 局真实对局，逐轮记录双方原话、听到的播报与局面变化。

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
  "reply": "我强攻，对手格挡，掉2点生命值，剩15。",
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
        "response": { "jsonrpc": "2.0", "id": 2, "result": { "content": [{ "type": "text", "text": "我强攻，对手格挡……" }] } }
      }
    ]
  }
}
```

- `reply` 是 Agent 转发与可选人设表达后的最终话术；`sourceReply` 是工具原文，供诊断来源与回退。当前 presentation 是文本兼容事实，不是 v2；v2 中工具文本块是 JSON，须解析并完成表达后才形成 reply，不能直接交页面或 TTS。
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
- 同一条连接上还有 `push` 事件，见下节；不认识该事件的旧客户端忽略即可。

### 主动推送（event: push）

服务端会在局面变化或玩家空闲一段时间后主动推一条提醒，不需要页面先发问。连接建立后的第一帧只建立基线，不补推连接前的旧事件；重连后的空闲计时从新连接算起，不会立刻催上一局留下的空闲。

```
event: push
data: {"type":"push","device":"web-p1","agent":"linx-sandbox","kind":"opponent-move","text":"对手强攻还没结算，我该格挡、闪避，还是承受？","tone":"alert","at":1761284004000}
```

| `kind` | 触发时机 | `tone` |
| --- | --- | --- |
| `opponent-joined` | 双人房对手加入，附开局事实 | `info` |
| `opponent-move` | 对手锁定招式，等你应对 | `alert` |
| `ult-ready` | 能量刚够大招且本局还没用过，推一次；现在不能出招时说清等轮到自己 | `info` |
| `idle-turn` | 轮到你出招，空闲 15 秒先轻催，40 秒再重催一次 | `wait` |
| `idle-respond` | 对手招式还等着你定，空闲 40 秒补一次 | `wait` |
| `wait-opponent` | 轮到你等对手，30 秒提醒一次 | `wait` |
| `wait-guest` | 房间一直没人加入，30 秒提醒一次 | `wait` |

- 同一个局面只催到规定次数；终局不推，避免和玩家那次行动的回复重复。
- 大招就绪只认服务端 `presentation.facts.you.ultimateReady`：能量不足、本局次数用完或当前不能出招时，不会说“可以用大招”；就绪推送每次就绪只发一次。
- `text` 是伙伴第一人称的短句，最多两句、约 60 字；页面可直接显示，也可以交给 TTS。
- 空闲基准取「局面最后变化、连接建立、本次变化」三者较晚者；玩家行动结算后局面变化，计时重新开始。
- 页面收到 `push` 会写进对话记录并朗读；正在朗读时只留最新一条排队，玩家正在说话、打字或页面隐藏时丢弃，不抢麦。麦克风只是开着待机不算「在说话」，朗读会短暂暂停收音再恢复。排队与丢弃逻辑在 `sandbox/public/push.js`。
- `/api/events` 代理原样透传 `push`，不需要额外配置。

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
| `pending` | 已锁定、等应对的攻击；`actor` 是「谁打出来的」，视角内 `player` 表示我已出手、等对手应对 |
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
| `SANDBOX_DISPLAY` | `screen` | 冒充的载体形态，进 `X-Linx-Display`；`voice` 表示无屏硬件，保留补账播报 |
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
| 局面一直「等待局面」 | 页面右上角的连接状态圆点是否绿色；`curl 'http://127.0.0.1:8100/api/config'` 看 `eventsUrl`；服务端是否开了 CORS（`/events` 自带） |
| 两个窗口是同一个玩家 | 用了复制标签页；换 `?player=2` 或「＋ 新窗口」 |
| 手机点麦克风没反应 | 页面不是 HTTPS；看页面上的降级提示 |

## 模拟平台Agent配置与验证状态

单源提示词为 [config/linx-agent-prompt.md](../../config/linx-agent-prompt.md)，`startSandbox` 在服务端启动时读取一次。`sandbox/config.ts` 的 `agent` 组读取 `SANDBOX_AGENT_MODEL`、`SANDBOX_AGENT_BASE_URL`、`SANDBOX_AGENT_API_KEY`，不继承游戏服务模型或密钥；不自动读取.env，模型名和服务商没有默认值。提示词路径按项目位置解析，不随启动工作目录改变。缺失或空提示词报错。

`SandboxAgent`每条原话只调用一次game_say，由服务端理解与执行。工具文本/isError及sourceReply保留，reply是页面实际展示和朗读的文字。MCP新增兼容字段structuredContent.presentation（version=1）：kind、certainty、facts和renderings。facts包括真实双方资源（本方含 `ultimateReady`）、轮次阶段、裁决events、下一步与明确拒绝原因；来自ServiceResult、Battle和引擎事件，不解析播报。等待朋友加入时不伪造对手资源；异常确定性为unknown，不能说未执行。

战况与已提交的行动结果提供由同一事实生成的完整句子候选；补账、唤出词与必要前缀完整保留。已确认开局（含开房等待／加入）、战况、明确重说与拒绝均可整句人设表达；重说和拒绝标为not-applied，不得说已经出手。未覆盖的帮助、闲聊、归属静默和结果未知异常仍使用原文。服务端默认text保持兼容；异常文案改为结果未确认、先核实战况，避免泛化“没生效，再说一次”。

用户允许整句人设表达，模型可自由生成完整话术，不限服务端renderings；该字段保留兼容参考，表达请求不发送它作为菜单。reply-check.ts进行有限启发式检查：数值及可识别的“我／对手”归属、明显胜负、单次闪避／格挡、待应对与下一步矛盾；同义词和句序变化可以通过，不使用完整句式白名单。数字归属或语义不易判定时可能保守回原文；检查也可能漏掉未覆盖的自然语言矛盾，不保证彻底验证所有语义，仍需人审与真实场景测试。

事实未知、未覆盖回复类型、模型异常或检查失败时采用已有工具原文，永不重试game_say。rewriteStatus区分rewritten、original、fallback-invalid、fallback-error；受控expressionError只含HTTP状态或通用不可用提示，不含认证头与响应正文。沙箱转发日志记录随机requestId、rewriteStatus和受控expressionError，不再记录原话或回复片段；可据此区别跳过表达、校验回退与模型请求失败。

表达适配器采用非流式OpenAI兼容Chat Completions，不提供游戏工具。服务商地址和模型由本地环境变量指定，实际可用性以获授权目的地的本轮验证为准。提示词启动读取一次，密钥仅通过用户本地受忽略.env和Node --env-file加载，不能source、入库、返浏览器或记录。游戏服务不继承沙箱表达密钥。

模型参数未配时是原话直连，不声称已有人设模型；不完整配置报错，完整配置创建表达层。当前运行进程不会热加载服务端改动，重启前须确认进程归属和无待保护的活动对局。实际模型服务可用性、平台结构化返回消费、真实ASR／TTS与手机体验须按本轮实测报告判断，不能用离线假模型通过代替。


### 页面对话记录

对话区保留本页会话的完整文本，按实际来源标注“玩家”“伙伴”“系统”；不写入后端对话日志，也不跨刷新持久保存。用户位于记录底部时，新消息和内容重排自动跟随；上翻历史时保持位置，点击“回到最新”后恢复跟随。实时识别文本单独展示，确认发送后才进入玩家消息记录。

## v2 联调边界

v2 尚未交付，不能用当前文本回包证明 v2 通过。实施后分别验证：原话只执行一次、JSON 编解码与未知版本、`silent` 零话术／零播放、表达成功与 `say` 兜底、`failed/unknown` 恢复、等待取消／超时／换局、等待与查询不重复消费战果。`/state` 和 `/events` 仍是视觉快照，不另起原文播报。

页面只把最终伙伴话术加入伙伴日志并播放，玩家输入与系统错误分开；部分识别不调用游戏，TTS 失败只处理播放，不重做 MCP。音频开始、结束和取消必须来自实际播放器事件，不能以合成完成替代播完。脚本记录应区分协议事实与最终话术，历史记录保留版本，不能改写旧录制冒充新协议验证。
