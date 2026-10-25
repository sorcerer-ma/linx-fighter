# MCP 协议 v2：事实通道与智能体演绎

> 状态：本分支在持久目录重建 v2；本地验证、真实模型和平台／真机验收分别记录。不是恢复原临时目录的提交或沿用旧测试。见 [迁移说明](mcp-v2-migration.md)。
> 相关：[架构与决策](architecture.md)、[接入灵犀平台](linx-integration.md)。

## 1. 一句话

服务端只回答「发生了什么、现在该谁动」，措辞交给平台智能体。

```
灵犀设备收音 → 平台 ASR（原话） → 智能体调 game_say(text=原话)
  → 本服务：判意图、维护对局、结算，返回 JSON 事实
  → 智能体读 JSON，照人设演绎 → 平台 TTS → 设备播报
```

## 2. 分工

| 层 | 负责 | 不负责 |
| --- | --- | --- |
| 灵犀平台 | 唤醒、VAD、ASR、把原话交给工具、TTS | 玩法判断、数值 |
| 本服务 | 把原话读成命令、房间与座位、结算、给事实 | 措辞、语气、人格 |
| 智能体 | 措辞、语气、节奏、把枚举说成人话 | 任何判断与数字 |

两条硬边界：**数值只有一个来源（服务端），措辞只有一个作者（智能体）**。协议的作用就是把「判断」压成枚举字段，把「表达」完整留空。

## 3. 设计原则

1. **入口只有一个**：`game_say(text)`。意图分类在服务端只做一次（`command.ts` 的 `readCommand`），智能体不做任何分类。
2. **出参是事实，不是台词**：`events` 是枚举与数字，能拿来对答案；不含修饰与语气。
3. **下一步由服务端指定**：`need` 直接告诉智能体要不要再调工具，智能体不推断时机。
4. **不能被演绎篡改的内容原样给**：玩法说明、规则外问答放 `text`，允许改语气，不许改事实。
5. **沉默是合法输出**：名单外的人、疑似自家播报回灌，返回 `silent`，智能体不出声。

## 4. 传输与格式

- 端点、Streamable HTTP / SSE 两条兼容路径、`DELETE /mcp` 收尾都不变。
- 身份与载体能力仍走请求头（`X-Linx-Device-Id` / `-Agent-Id` / `-Session-Id` / `x-linx-display`），不进工具入参。
- 返回固定为 `content: [{type: "text", text: "<JSON>"}]`，一个 JSON 对象，不缩进、不包代码块、不带任何前后文案。不使用 `image`、`audio`、`structuredContent`。
- `isError` 只表示服务自身故障（进程异常、依赖不可用）；业务上的「这一手没生效」一律走 `ok: false` + `reason`，智能体不需要区分两条错误通道。
- 单个 JSON 文本块 UTF-8 上限为 **16 KiB（16,384 字节）**，wait_event 相同。这是项目上限，尚未证实灵矽平台容量。超限不截断 JSON／事实，返回有界 isError:true、reason:unknown，不能重复行动。
- 入参 `text` 长度 1~200 字；超长按没听清处理（`reason: "unclear"`），不截断执行。
- 沙箱、`GET /state`、`GET /events` 不受影响，仍是 v1 快照；沙箱发现代链路问题时先看这里。

## 5. tools

v2 只有两个工具。v1 的 `game_start`、`game_action`、`game_status`、`game_help` 全部并入 `game_say`——它们的区别只在于「这句话属于哪一类」，而这正是服务端在做的事；每多一个工具，就是多一次智能体自己选工具的判断。

### 5.1 `game_say`

```json
{
  "name": "game_say",
  "description": "玩家说了一句话，原样交给游戏。text 必须是原话，不改字、不总结、不补上下文。服务端自己判断这句话是出招、应对、查战况、问玩法还是开局。返回 JSON：events 是刚发生的事，need 是接下来该谁动，ok 为 false 时 reason 说明为什么没生效。",
  "inputSchema": {
    "type": "object",
    "properties": {
      "text": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200,
        "description": "玩家的原话，一字不改。"
      },
      "speaker": {
        "type": "string",
        "maxLength": 20,
        "description": "说话人称呼，由平台声纹自动填入。没有就不要传，不要自己编。"
      }
    },
    "required": ["text"],
    "additionalProperties": false
  }
}
```

`speaker` 只用于说话人门禁与日志，不参与招式裁决，也不决定对局归属（归属仍看请求头）。平台是否真的会填这个字段见第 10 节。

### 5.2 `wait_event`

```json
{
  "name": "wait_event",
  "description": "当上一次返回的 need 是 wait_guest 或 wait_foe 时调用：把请求挂起，等对手进房间或对手出招，有结果就返回。没有参数，超时由服务端决定。返回结构同 game_say。一轮里最多调用一次。",
  "inputSchema": {
    "type": "object",
    "properties": {},
    "additionalProperties": false
  }
}
```

挂起期间平台先断开时按取消收尾，返回一发合法的 JSON（`need` 不变，`events` 为空），智能体照常演绎等待中那句。

## 6. 出参

### 6.1 字段

| 字段 | 类型 | 出现时机 | 含义 |
| --- | --- | --- | --- |
| `v` | `2` | 总是 | 协议版本 |
| `ok` | bool | 总是 | 这句原话是否被处理 |
| `silent` | `true` | 少数 | 不要出声 |
| `phase` | enum | 非 `silent` 响应 | `idle` / `room` / `battle` / `victory` / `defeat` |
| `need` | enum | 有对局或房间 | `move` / `respond` / `wait_guest` / `wait_foe` / `none` |
| `mode` | enum | 有对局 | `solo` / `pvp` |
| `room` | string | 双人 | 四位房间号 |
| `round` | int | 有对局 | 第几轮 |
| `you` | object | 有对局 | `{hp, maxHp, ap, maxAp, ult}`，`ult` 是剩余大招次数 |
| `foe` | object | 有对局 | `{name, hp, maxHp, ap, ult}` |
| `pending` | object | 有锁定攻击 | `{by, mv, dmg}`：谁出的招、什么招、基准伤害（还没结算，暴击会更高、格挡会减）；`by: "you"` 表示自己已出手等对手应对 |
| `choices` | string[] | `move` / `respond` | 现在真正做得到的招式中文名，服务端已按阶段、能量、大招次数过滤 |
| `deny` | object | `no_ap` / `no_ult` | `{mv, need?, short?}`：被打回的招式、这招要多少能量、还差几点 |
| `events` | object[] | 有变化 | 本次发生了什么，按时间顺序 |
| `text` | string | 少数 | 需要照说的原文（玩法说明、规则外问答） |
| `say` | string | 每次（有 `text` 或 `silent` 时不给） | 服务端算好的平实兜底句，只含已结算事实，两句以内 |
| `reason` | enum | `ok: false` | 为什么没生效 |

`you` / `foe` 都是**结算后的最新值**，不是增量。`choices` 由服务端算好，智能体不需要懂能量规则，也不会引导玩家说一个做不到的招。

`say` 是**兜底，不是台词**：刻意写得平实、不带修辞（直接复用 `narrator.ts` 的现有战斗句），只在三种情况照念——措辞拿不准、结论涉及数字或胜负要一字不差、刚才说错了要更正。正常情况必须自己按 `events` 演绎，否则 v2 退化成「服务端写死、模型复读」。这个比例要真机看（第 10 节）。

`deny` 的理由和 `choices` 一样：能量缺口由服务端算好，模型不碰算术。

`failed` 只用于能够确认未执行的失败；执行可能已发生而结果无法确认时才用 `unknown`，不能仅按是否写库机械分类。已经能够确认成功时不能改说失败。可取得的最新局面与 `say` 用于核实；快照也不可取得时的最小返回尚需按[迁移说明](mcp-v2-migration.md#具体边界)明确，不能伪造状态。网络或服务异常时先核实局面、不把重复攻击当通用恢复方式是产品要求（[语音与信息反馈](../product/voice-and-feedback.md)、[玩家旅程](../product/player-journey.md)）。

### 6.2 `phase` × `need`

| 局面 | phase | need | 智能体动作 |
| --- | --- | --- | --- |
| 没有对局 | `idle` | `none` | 直接说 |
| 开了房等人 | `room` | `wait_guest` | 说房间号，再调 `wait_event` |
| 轮到我出招 | `battle` | `move` | 直接说，问要打哪一招 |
| 对手已出招、等我应对 | `battle` | `respond` | 直接说，让玩家选 `choices` |
| 我已出招等对手 / 双人轮对手 | `battle` | `wait_foe` | 说一声等着，再调 `wait_event` |
| 对局结束 | `victory` / `defeat` | `none` | 直接说，邀新局 |
| 门禁静默 | 任意 | 无 | 只输出零宽空格 |

`need` 是唯一决定「要不要再调工具」的字段，映射固定，不需要推理。

### 6.3 `events`

| `t` | 字段 | 含义 |
| --- | --- | --- |
| `start` | `foe`, `first` | 开局；`first` 是 `you` / `foe` |
| `room` | `code` | 开好房间 |
| `join` | `code` | 加入房间；若随即开局，后面紧跟一条 `start` |
| `round` | `n`, `bonus` | 进入新一轮；`bonus > 0`（第 3 轮起）才有伤害加成 |
| `charge` | `by`, `ap` | 蓄力；`ap` 是蓄力后的能量 |
| `hit` | `by`, `mv`, `r`, `dmg`，可选 `miss` / `crit` / `forced` | 一次攻击结算 |
| `end` | `win` | 终局；`win` 是 `you` / `foe` |
| `timeout` | `what` | 挂起超时；`what` 是 `guest`（没人进房）/ `foe`（对手没出手） |
| `chant` | `text` | 玩家念了唤出指令，先把原句回念一遍 |

`hit` 的读法只有五种，覆盖全部情况：

| 字段组合 | 事实 |
| --- | --- |
| `r: "guard"` | 对方格挡，伤害已减 |
| `r: "dodge"` + `miss: true` | 真躲开了，`dmg` 为 0 |
| `r: "dodge"`（无 `miss`） | 躲晚了，吃满伤害 |
| `r: "take"` | 硬接 |
| `r: "take"` + `forced: true` | 对方没能量，只能硬扛 |

`crit: true` 可与上面任意组合，表示暴击。`dmg` 为 0 只可能来自闪避成功或满减。

### 6.4 `reason`

| 值 | 触发 | 智能体该说的 |
| --- | --- | --- |
| `unclear` | 没听清、不像游戏指令、超长 | 请玩家把这一手再说一次 |
| `negated` | 明确说不打（「不要大招」） | 没打出去，想动手就直接说招式 |
| `ambiguous` | 一句话点了两种招式 | 一次只说一种 |
| `wrong_stage` | 阶段不对（应对时说出招、主动时说格挡） | 现在只能做什么，看 `choices` |
| `no_ap` | 能量不够 | 差多少看 `deny.short`；可以先蓄力，应对阶段只能承受 |
| `no_ult` | 大招已用完 | 换一招 |
| `waiting` | 已经出招，等对手应对 | 在等对手 |
| `ended` | 对局已结束 | 报结果，邀请再来一局 |
| `room_missing` | 房间号不存在或已过期 | 确认四位房间号 |
| `room_full` | 房间满员 | 自己开一局或换号 |
| `room_bad` | 房间号不是四位数字 | 房间号要四位数字 |
| `failed` | 确定没生效：入参非法、动状态之前就失败 | 这一手没打出去，直接说招式 |
| `unknown` | 执行中途出错，可能已经生效 | 先报当前局面，让玩家自己决定；不要让他重说同一个招 |

### 6.5 示例

线上是单行紧凑 JSON，以下为便于阅读折行。第一个示例带 `say`，其余省略——真实返回每次都有。

单人局第 1 轮，玩家回应「格挡」，对手普攻被挡下：

```json
{"v":2,"ok":true,"phase":"battle","mode":"solo","round":2,"need":"move",
 "you":{"hp":13,"maxHp":14,"ap":2,"maxAp":5,"ult":1},
 "foe":{"name":"守擂教头","hp":15,"maxHp":18,"ap":2,"ult":1},
 "choices":["普攻","强攻","蓄力"],
 "events":[{"t":"hit","by":"foe","mv":"light","r":"guard","dmg":1},
           {"t":"round","n":2,"bonus":0}],
 "say":"他普攻，我格挡，掉1点，剩13点。第2轮，轮到你出招。"}
```

推演（数值以 `src/game/rules.ts` 为准）：我强攻，他格挡掉 3（18→15）；他普攻，我格挡掉 1（14→13）；第 2 轮轮到我，能量 2 点还放不出大招，所以 `choices` 里没有它。

双人局，玩家刚出大招，等对手应对：

```json
{"v":2,"ok":true,"phase":"battle","mode":"pvp","room":"4821","round":3,"need":"wait_foe",
 "you":{"hp":9,"maxHp":14,"ap":0,"maxAp":5,"ult":0},
 "foe":{"name":"对面那位","hp":6,"maxHp":18,"ap":4,"ult":1},
 "pending":{"by":"you","mv":"ult","dmg":11},"events":[]}
```

大招 9 点加第 3 轮加成 2 点，`dmg` 是 11 的基准值；对手格挡就少 2，暴击就多 2，现在还没有结果。`pending.by` 是 `you`，智能体据此说「我这招压上去了，等他应对」。

双人开房：

```json
{"v":2,"ok":true,"phase":"room","mode":"pvp","room":"4821","need":"wait_guest",
 "events":[{"t":"room","code":"4821"}]}
```

能量不够（玩家喊「大招」，只有 2 点能量）：

```json
{"v":2,"ok":false,"reason":"no_ap","phase":"battle","mode":"solo","round":2,"need":"move",
 "you":{"hp":13,"maxHp":14,"ap":2,"maxAp":5,"ult":1},
 "foe":{"name":"守擂教头","hp":15,"maxHp":18,"ap":2,"ult":1},
 "choices":["普攻","强攻","蓄力"],"deny":{"mv":"ult","need":4,"short":2},"events":[]}
```

服务异常，结果未知（带局面与兜底句）：

```json
{"v":2,"ok":false,"reason":"unknown","phase":"battle","mode":"solo","round":2,"need":"move",
 "you":{"hp":13,"maxHp":14,"ap":2,"maxAp":5,"ult":1},
 "foe":{"name":"守擂教头","hp":15,"maxHp":18,"ap":2,"ult":1},
 "choices":["普攻","强攻","蓄力"],"events":[],
 "say":"这一手不确定成没成，我先报现在的局面。"}
```

不说话：

```json
{"v":2,"ok":true,"silent":true}
```

## 7. 智能体提示词

本节是协议配套的**示意稿**，用来说明每个字段怎么读；当前文本协议模板与切换步骤见[平台接入](linx-integration.md#6-智能体提示词与协议切换)。平台实际提示词手动配置，沙箱模板由后续实现提供，二者需同步调用规则、字段解释与异常／等待边界，人格可以不同，不宣称仓库自动同步平台。`{{...}}` 由接入方按本机人格填，其余不要改——协议枚举与这张表必须对得上。

```
你是{{伙伴名字}}，玩家身边的共鸣伙伴。你附在他的招式上，替他出声。第一人称「我」，叫他「你」，对面一律叫「对手」。

【你只做两件事】
1. 玩家说的每一句话，原样交给 game_say，一字不改、不总结、不猜他想干什么。
2. 把 game_say 和 wait_event 返回的事实，说成你自己的话。

【绝对不做】
不判断招式、伤害和胜负；不改任何数字；不替玩家选招；不预告还没发生的结果；不说「系统」「接口」「数据」「字段」；不复述玩家原话。

【调用规则】
- 玩家一开口就调 game_say(text=原话)。哪怕他只说「嗯」「等一下」，也原样传。
- 返回的 need 是 wait_guest 或 wait_foe，且这一轮还没调过 wait_event：把这一句说完，再调 wait_event，没有参数。
- 其他 need 一律不再调工具，直接开口。
- 一轮最多调一次 wait_event。
- speaker 由平台填，你不要填。

【怎么读返回】
- silent 为 true：只输出一个零宽空格（U+200B），什么也别说，不要解释。
- 有 text：照着 text 的意思说，不用 say。事实、规则、房间号、数字一律不许改，最多加一句自己的语气。
- 有 say：默认不用，自己按 events 说。只有三种情况照念——你拿不准怎么说、结论涉及数字或胜负要一字不差、刚才说错了要更正。照念时不许改事实，也不许加未结算的伤害或剩余生命值。
- 其余：只依据 events、need、you、foe、pending、choices、deny 说话。

【说话】
两句以内，60 字以内，口语，像站在旁边的人。可以说感受、喊招、形容动作、吐槽对手、提醒下一步，风格完全自由。数字只用返回里的，最多念两个。事情说清就停，别总结，别复述刚说过的。

【字段】
phase：idle 没开局 / room 房间等人 / battle 打着 / victory 我赢 / defeat 我输。
need：
  move       该玩家出招：问他要打哪一招，可以提 choices 里的
  respond    对手打过来了：pending 是它的招式和基准伤害，让他选 choices
  wait_guest 等人进房间：说房间号，然后调 wait_event
  wait_foe   等对手出招：pending.by 是我，就说我这招已经压上去；说一声等着，然后调 wait_event
  none       没别的事了
you / foe：hp 生命值、ap 能量、ult 剩余大招次数，都是最新值。
pending：by=foe 是对手打过来还没结算，by=you 是我这一手已出手等他应对；dmg 是基准伤害，暴击更高、格挡更低。
choices：现在真做得到的招式，别推荐不在里面的。

【events 按顺序说，每条都要说到】
start   开局：说出对手名字、谁先手
room    开好房：报房间号，告诉他说「加入房间XXXX」就能进
join    进了房：报房间号，紧跟着的 start 一起说
round   新一轮：只有 bonus 大于 0 时才提「这一轮开始伤害更高」
charge  蓄力：谁蓄力、能量到几点
hit     交手：by 谁打谁，mv 招式，r 对方怎么应对，dmg 掉了多少
          r=guard 格挡挡下；r=dodge 且 miss 是真躲开了；r=dodge 没 miss 是躲晚了吃满；
          r=take 是硬接；r=take 还带 forced 是对面没能量只能硬扛；crit 是暴击，一定要说
end     结束：win=you 说赢了，win=foe 说输了，再说一句可以再来一局
timeout 没等到：what=guest 是人还没进房，what=foe 是对手还没出手，让他等会儿再喊你
chant   玩家念了咒语：先把 text 原句念一遍，再说这一手的结果

【ok 为 false 时，按 reason 说】
unclear      没听清：请他把这一手再说一次
negated      他说不打：说没打出去，想动手就直接说招式
ambiguous    一句话两种招：一次只说一种
wrong_stage  现在不是出这招的时候：说现在能干什么，看 choices
no_ap        能量不够：deny.short 是还差几点，照它说；可以先蓄力，或者只能硬挨
no_ult       大招用过了：让他换一招
waiting      已经出招了：说在等对手应对
ended        这一局完了：报结果，再邀请他开新局
room_missing 房间不存在：让他确认四位房间号
room_full    房间满了：让他自己开一局或换个号
room_bad     房间号不对：房间号要四位数字
failed       确定没生效：说这一手没打出去，让他直接说招式
unknown      不确定成没成：先报现在的局面，别让他重说同一个招

【你的说话方式】
{{这里随便写：傲、损、热血、冷淡都行。写你怎么称呼玩家、爱用哪些说法、赢输时怎么反应。这一段是唯一影响风格的地方。}}
```

两个示例（可删，但建议留着对齐格式）：

```
玩家「强攻」，events 里有 {"t":"hit","by":"you","mv":"heavy","r":"guard","dmg":3}，foe.hp 是 12：
→ 强攻砸上去，他架住了，还是掉了 3 点，对手剩 12。要不要补一脚？

玩家「打他」，need 是 respond，pending 是 {"by":"foe","mv":"ult","dmg":11}：
→ 他大招压上来了，就等你这一手。格挡、闪避，还是硬接？

不要说这种话：「第 3 轮，我 14 点生命值、2 点能量，对手 7 点生命值。」——这是播报，不是同伴。
```

## 8. 与 v1 的差异

| | v1 | v2 |
| --- | --- | --- |
| 工具数 | 5（加 `wait_event` 共 6） | 2 |
| 入参 | 每个工具一组结构化参数 | 只有原话（+ 平台填的 speaker） |
| 出参 | 可直接朗读的中文 | 单行 JSON 事实 |
| 谁写台词 | 服务端 `narrator.ts` | 智能体 |
| 兜底句 | 台词本身就是兜底 | `say` 平实兜底，只在模型拿不准时照念 |
| 语气上限 | 服务端固定两句、60 字 | 提示词约束，风格自由 |
| 阶段提示 | 写死在播报里 | `phase` + `need` |
| 拒绝原因 | 中文文案分支 | `reason` 枚举 |
| 补账 | 服务端加「刚才那一手。」 | 事件按序返回，智能体自己衔接 |
| 异常与不确定 | 一律「没生效，请再说一次」 | `failed` / `unknown` 分开，`unknown` 先报局面 |
| 回灌识别 | 播报句式正则（`crosstalk.ts`） | 覆盖变窄：句式自由后旧词表只命中一部分，需补时间窗，见第 10 节 |

## 9. 落地清单

| 改动 | 位置 |
| --- | --- |
| 工具注册与出参序列化 | `src/mcp/tools.ts`：两个工具、`invoke()` 里把 `ServiceResult` 转 JSON |
| 返回结构 | `src/game/service.ts`：`ServiceResult` 从 `{text, battle}` 改为 `{reply}` 事实对象 |
| 事件到 JSON | 复用 `BattleEvent`，补 `room` / `join` / `timeout` / `chant` |
| 状态字段 | 复用 `src/game/state.ts` 的 `BattleState`，字段名对齐本文 |
| 能量缺口 | `src/game/state.ts`：按招式成本算 `deny.need` 与 `deny.short`，随拒绝结果返回 |
| 播报层 | `src/game/narrator.ts` 收缩为 `text` 与 `say` 两类文案：玩法说明、规则外问答、异常兜底，以及每手的平实兜底句；带人设的演绎交给智能体 |
| 异常边界 | `src/game/service.ts`：确认未执行才给 `failed`；可能执行且结果未确认给 `unknown`，有可靠快照时带回，不能编造局面 |
| 测试 | `test/tools.test.ts` 的工具清单断言、`mcp.e2e.test.ts` 的出参断言 |

过渡：服务端可保留一个 `MCP_PROTOCOL=text|json` 开关，但**开关与平台提示词必须成对切换**——v2 提示词配 v1 文本会被当成台词复读，v1 提示词配 v2 JSON 会把 JSON 念出来。建议一次只切一台设备，验完再全量。

## 10. 未决与风险

| 项 | 现状 | 影响 |
| --- | --- | --- |
| 回灌识别 | v1 靠 `crosstalk.ts` 的播报句式正则；演绎后句式自由，同一张表只能命中一部分 | 第一道防线在平台：设备自己的 TTS 没有注册声纹，「只回应已添加说话人」应能挡掉（推断，见[平台语音能力](platform-voice-capabilities.md)，需真机验）。服务端只做降级网：时间窗 + 招式名/数字集合，宁可漏判也不吞真指令；服务端看不到最终播报文本，别指望「相似度」 |
| 挂起前后的播报顺序 | 未验证：平台会不会在工具返回前把上一句播出去 | 不播则房间号、「等我一下」会迟到 30 秒；真机验，必要时改成先挂起、返回后再补说 |
| `speaker` 是否真被平台自动填入 | 官方文档写「平台不会填入工具入参」，实测经验相反（见[平台语音能力](platform-voice-capabilities.md)） | 填不进来则说话人门禁失效，只能挡不住串音；需真机日志确认 |
| 模型是否稳定照做 | 未验证 | 风险：念 JSON、编数字、漏说暴击、把 `say` 当固定台词照念。保底是 `say` 与日志回放；真机 10 局同时记「念 `say` 的比例」，过高就收紧第 7 节的照念条件 |
| 提示词维护 | 第 7 节是协议示意，[平台接入](linx-integration.md#6-智能体提示词与协议切换)提供当前模板与切换说明 | 平台手动配置与沙箱模板需同步协议规则，人格可不同；不能假定配置自动同步或已生效 |
| `structuredContent` 是否传给模型 | 未确认 | v2 不依赖它，结论不受影响 |
| 提示词长度上限 | 未知 | 第 7 节提示词约 2.2k 字（4.5KB），超限需先砍字段表后砍示例 |
| 端到端延迟 | 未实测 | 多一次模型生成（约 0.5~2 秒），`wait_event` 唤醒后尤其明显，演示前实测体感 |
