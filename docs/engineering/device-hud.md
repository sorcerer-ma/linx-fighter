# 设备 HUD 通道（当前实现）

> 面向硬件的只读状态通道：服务端把对局局面派生成屏幕能直接消费的画面状态，设备通过 `/device/mcp` 上的 `game_hud` 长轮询拉取；平台侧 `/mcp` 工具面不变，仍是 `game_say` 与 `wait_event`。固件侧改动基于小智开源固件上游 v2.1.0，代码暂存仓库外，见文末。

## 为什么单独开一条通道

平台给设备的 MCP 是「平台调设备」：设备是 server、平台是 client，且工具描述 API 只能改提示词，无法确定性驱动屏幕。反向由平台智能体转述战斗状态既慢也不可靠。因此设备另做 MCP client，主动拉服务端派生好的画面状态：

```
战斗规则/事件 ──► deriveHud() ──► HudState ──(长轮询 /device/mcp)──► 设备 HUD
                                        └──(载荷沿用 MCP content.text)
```

服务端仍是唯一裁决方：设备只渲染，不推导数值。

## 设备通道契约

- 入口：`POST /device/mcp`（Streamable HTTP，无状态），`DELETE /device/mcp` 收尾返回 200；`GET /` 的 `endpoints` 里多一个 `device: '/device/mcp'`。
- 工具：只有一个 `game_hud`，入参 `wait_ms`（整数 0–5000，默认 0）。`wait_ms>0` 时按 150ms 步进长轮询，直到画面帧号 `seq` 变化或超时，再返回最新一帧。
- 返回：`content[0].text` 是单行 JSON：

| 字段 | 含义 |
| --- | --- |
| `ok` | 恒为 `true`，设备据此判断载荷有效 |
| `battle` / `room` / `waiting` | 是否在局、房间号、是否在等对手或对手出招 |
| `expression` | 8 表情之一：`neutral`、`attack`、`hurt`、`guard`、`dodge`、`ultready`、`victory`、`defeat` |
| `hp` / `max_hp` | 生命值，设备画爱心与加粗辅助条，不显示数字 |
| `energy` / `max_energy` | 能量，设备画 5 个闪电（实心/空心） |
| `ult` | 大招徽记三态：`0` 未就绪、`1` 可释放、`2` 本局已用 |
| `cue` | 本次要播的音效名，仅表情切换那一帧才有，待命为空 |
| `seq` | 画面帧号，同帧重复拉取不涨号，设备据此去重 |
| `hold_ms` | 瞬时表情停留时长，0 表示常驻 |

- 身份：优先按 `deviceId#agentId` 精确命中；设备只带 MAC 时，扫 `store.list()` 中前缀为 `deviceId#` 的房间，取 `battle.updatedAt` 最新的一局，避免「同一台设备上一个 agentId」导致取不到对局。

## 画面派生规则

实现在 `src/game/hud.ts`：

- 表情优先级：等对手/等对手出招 → `neutral`；`victory`/`defeat` 直接对应；最近一次战报（按 `state.updatedAt` 判断是否新帧）→ `attack`（自己出招）、`hurt`（对手命中）、`guard`（自己格挡）、`dodge`（闪避成功）；可释放大招时 → `ultready`；其余 → `neutral`。
- 大招可释放沿用 `isUltimateReady`：对局进行中、轮到自己主动、没有待应对招式、能量达到门槛且本局还有大招次数。
- 瞬时表情由设备按 `hold_ms` 回落，服务端不额外计时；重复拉取同一帧不重复给 `cue`，避免音效连播。
- 待命帧（无对局）`battle:false`、`hp:0`、`max_hp:1`，避免设备除零或画出满血条。

## 固件侧（小智上游 v2.1.0 + 本项目补丁）

- 显示：`main/display/battle_hud.cc|h` 在官方简单式 UI 上叠加战斗层——8 张表情位图（240×170，RGB565 未压缩，放 `battle_assets.c`）、生命条、5 个闪电、右上角大招徽记；原生文字/情绪/状态栏在启动时隐藏，平台情绪按 `angry/sad/crying→defeat`、`surprised/shocked→hurt`、其余 → `neutral` 映射。
- 音效：8 段 16kHz 单声道 ogg 放进 `main/assets/common/`，由 `scripts/gen_lang.py` 生成 `OGG_READY/ATTACK/HURT/GUARD/DODGE/ULT/VICTORY/DEFEAT`，经 `AudioService::PlaySound` 播。
- MCP：设备自身注册 `self.hud.set_state`、`self.hud.get_state`、`self.hud.demo`，平台智能体可直接调；另在 USB Serial/JTAG 上跑标准 MCP JSON-RPC（`initialize`、`tools/list`、`tools/call`）供本机联调。
- 启动点：HUD 在 `Application::Initialize()` 里初始化；不能放进 `LcdDisplay::SetupUI()`——那是 `Board::GetInstance()` 构造过程的一部分，HUD 内部再取 Board 会撞上静态初始化重入而卡死。

## 验证与证据

- 服务端：`pnpm typecheck`、`pnpm test`（新增 `test/hud.test.ts` 与 `test/hud-http.test.ts`，覆盖待命帧、瞬时表情、大招三态、帧号去重、长轮询与通道工具面）。
- 真机：设备 USB 连接下用仓库外的 `hud/host/mcp_drive.py` 发 `initialize`/`tools/list`/`tools/call`，`set_state` 驱动 8 表情与音效，`get_state` 回读；开机自检会自动轮播一遍。
- 证据与脚本（均在仓库外）：`~/Documents/linx-hud-spike/hud/evidence/`（`device_overview.png`、`mcp_transcript.jsonl`）、`~/Documents/linx-hud-spike/hud/host/mcp_drive.py`。

## 已知限制

- 固件按上游 v2.1.0 重建，丢掉了厂商私有工具 `self.system.set_aec`、`self.system.switch_TFT`；这是替换镜像的代价，需要厂商源码才能补回。
- esp-sr 语音模型未随镜像打包，唤醒词暂不可用；HUD 与 MCP 不受影响。
- 板级默认 10 分钟无操作深睡（断电 5V、USB 一并失联），联调版已关掉自动关机，保留 60 秒降亮度；长按侧键仍可休眠。
- 设备通道目前只读，尚未接入平台智能体；设备侧 HudClient（固件定时拉 `/device/mcp`）仍是后续工作，现阶段用 USB 上的 MCP 调用驱动。
