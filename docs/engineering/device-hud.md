# 设备 HUD 通道（当前实现）

> 面向硬件的只读状态通道：服务端把对局局面派生成屏幕能直接消费的画面状态，设备通过 `/device/mcp` 上的 `game_hud` 长轮询拉取；平台侧 `/mcp` 工具面不变，仍是 `game_say` 与 `wait_event`。固件侧改动基于小智开源固件上游 v2.1.0，代码暂存仓库外，见文末。

## 为什么单独开一条通道

平台给设备的 MCP 是「平台调设备」：设备是 server、平台是 client，且工具描述 API 只能改提示词，无法确定性驱动屏幕。反向由平台智能体转述战斗状态既慢也不可靠。因此设备另做 MCP client，主动拉服务端派生好的画面状态：

```
权威对局 ──► BattleFrame ──► Facts ──┬──► 平台事实（/mcp 的 content.text）
                                     └──► hudFromFacts() ──► HudState ──(长轮询 /device/mcp)──► 设备 HUD
```

服务端仍是唯一裁决方：设备只渲染，不推导数值。

## 一条事实，两个投影

屏幕不是第二条协议，而是**事实的投影**：表情只可能在「收到一局事实」之后出现，没有新事实时设备停在待命（只有本地的眨眼与呼吸）。

- `src/game/frame.ts` 把基准对局与镜像快照统一成视角化局面 `BattleFrame`（`you` / `opponent` / `pending` / `lastTurn`），平台事实与屏幕画面都只读这一份；
- `src/game/presentation.ts` 的 `factsOf()` 从同一份局面装配 `Facts`（新增 `room`、`updatedAt`、`lastTurn` 与资源上限 `maxHp`/`maxEnergy`），仍是加法式扩展，`v:2` 事实字段与平台调用方式不变；
- `src/game/hud.ts` 的 `hudFromFacts()` 只吃 `Facts`：帧里的轮次、资源、最近一手、下一步都来自事实，不在投影里另算；
- 因此「平台收到的样子」与「屏幕显示的样子」不会各写一遍判断；以后新增一种战报，两边同时生效。

## 设备通道契约

- 入口：`POST /device/mcp`（Streamable HTTP，无状态），`DELETE /device/mcp` 收尾返回 200；`GET /` 的 `endpoints` 里多一个 `device: '/device/mcp'`。
- 工具：只有一个 `game_hud`，入参 `wait_ms`（整数 0–5000，默认 0）。`wait_ms>0` 时按 150ms 步进长轮询，直到画面帧号 `seq` 变化或超时，再返回最新一帧。
- 返回：`content[0].text` 是单行 JSON：

| 字段 | 含义 |
| --- | --- |
| `ok` | 恒为 `true`，设备据此判断载荷有效 |
| `battle` / `room` / `waiting` | 是否在局、房间号、是否在等对手或对手出招 |
| `round` | 第几轮，与事实的 `round` 同源，便于日志对齐 |
| `expression` | 8 表情之一：`neutral`、`attack`、`hurt`、`guard`、`dodge`、`ultready`、`victory`、`defeat` |
| `hp` / `max_hp` | 自己的生命值；设备画爱心、当前值数字与加粗辅助条（上限由条长表达） |
| `energy` / `max_energy` | 自己的能量，设备只画 5 个闪电（实心/空心），不写数字 |
| `ult` | 自己右上角大招徽记三态：`0` 未就绪、`1` 可释放、`2` 本局已用 |
| `mode` | 对局形态：`solo` 单人局（看屏的是本人，上排画自己）、`pvp` 双人房（两块屏相对，看屏的是对面，上排画对手）；无对局为 `null` |
| `opponent` | 对手资源块 `{hp, max_hp, energy, max_energy, ult}`，画在另一行与另一角徽记；等对手加入或没有对局时为 `null`，设备只画自己这一行 |
| `cue` | 本次要播的音效名，仅表情切换那一帧才有，待命为空 |
| `seq` | 画面帧号，同帧重复拉取不涨号，设备据此去重 |
| `hold_ms` | 瞬时表情停留时长，0 表示常驻 |

对局结束（`victory` / `defeat`）后先定格 6 秒展示结局与双方资源，超时后派生为待命帧：`battle:false`、表情回 `neutral`、资源与徽记全部收起，设备同时把表情控制权交回平台情绪。定格时长由 `src/game/hud.ts` 的 `HUD_ENDED_HOLD_MS` 控制。

- 身份：优先按 `deviceId#agentId` 精确命中；设备只带 MAC 时，扫 `store.list()` 中前缀为 `deviceId#` 的房间，取 `battle.updatedAt` 最新的一局，避免「同一台设备上一个 agentId」导致取不到对局。

## 画面派生规则

实现在 `src/game/hud.ts` 的 `hudFromFacts()`，输入只有 `Facts`：

- 表情优先级：`next==='wait-join'` → `neutral`；`phase` 为 `victory`/`defeat` 直接对应；`lastTurn` 在展示窗口内（按 `facts.updatedAt` 判断新帧）→ `attack`（自己出招）、`hurt`（对手命中）、`guard`（自己格挡）、`dodge`（闪避成功）；`next==='act'` 且 `you.ultimateReady` → `ultready`；其余 → `neutral`。
- 大招就绪沿用事实里的 `you.ultimateReady`（对局进行中、轮到自己主动、没有待应对招式、能量达到门槛且本局还有大招次数），描述符不再自己拼条件。
- 瞬时表情由设备按 `hold_ms` 回落，服务端不额外计时；重复拉取同一帧不重复给 `cue`，避免音效连播。
- 待命帧（无对局）`battle:false`、`hp:0`、`max_hp:1`，避免设备除零或画出满血条；设备收到 `battle:false` 只画表情，不画资源行与徽记。
- 行序规则：上排永远是「看这块屏的人」。`pvp` 时两块屏相对，看屏的是对面玩家，上排画对手、左上角是对手徽记；`solo` 时看屏的是本人，上排画自己、左上角是自己徽记。

## 固件侧（小智上游 v2.1.0 + 本项目补丁）

固件源码在仓库外：二进制与补丁在 `~/Documents/linx-hud-spike/firmware/`，生成脚本与证据在 `hud/`；仓库只维护通道契约与画面派生规则。

### 显示栈

- 保留官方「简单式」UI（`USE_DEFAULT_MESSAGE_STYLE`），启动时隐藏 `emoji_box_`、`top_bar_`、`status_bar_`、`bottom_bar_`，在同一 `screen` 上叠一层战斗 HUD：
  - 整屏底色：LVGL 纯色矩形，切换时 300ms 自算 RGB 插值；
  - 表情前景：`face_view` 管理的两张 `lv_image` 交叉淡入，加闪避残影；
  - 两行资源（两块屏相对摆放：上排对手、下排自己）：行高约 14px，y 分别为 `190`/`212`；每行爱心在 `x=8`、当前生命值数字（Montserrat 12）在 `x=27`、生命轨道从 `x=50` 拉通到 `x=214`、5 个闪电 `x=224+i*19` 贴右边；能量只画闪电不写数字。
  - 大招徽记：左上角 `(6,4)` 画对手三态、右上角 `(284,4)` 画自己三态；没有对手时左上角与上排一起隐藏。
- 初始化点必须在 `Application::Initialize()` 里：`auto display = board.GetDisplay(); battle_hud_create(display); battle_ctl_start(); battle_pull_start();`。**不能放进 `LcdDisplay::SetupUI()`**（见踩坑 1）。
- 平台情绪照常接收，但一旦 HUD 收到过显式状态就置 `locked`，不再被情绪覆盖；`hud.unlock` 解除。

### 表情资产管线（从设计稿到固件）

1. 设计稿：用户导出的 SVG 里 8 个画板排成 4×2，每块 76.8×57.6，整张 `viewBox="0 0 308 116"`。8 个文件内容完全相同，解析一份、按画板原点平移即可拆出 8 个表情。
2. 渲染：把根节点 `viewBox`/`width`/`height` 改成单个画板（320×240），用 Chrome headless 截图：
   `"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 --window-size=320,240 --screenshot=out.png file://sheet.html`
   再生成一份「删掉背景色矩形」的 SVG，加 `--default-background-color=00000000` 输出透明前景。
3. 裁剪：按 alpha>8 求包围盒、留 2px 边距，得到每张图的 `(x,y,w,h)`；背景色交给 LVGL 纯色绘制，不烘进位图。
4. 转 C：`scripts/Image_Converter/LVGLImage.py --ofmt C --cf RGB565A8 --compress NONE`，生成 `face_assets.c/.h`（每个符号带 `FACE_<NAME>_X`/`_Y` 偏移宏，`face_view.cc` 摆放时叠加偏移）。
5. 容量：app 分区 4,032KB，2.1.8 版镜像 3,798,128 字节；未压缩前景合计约 840KB。**不要用 RLE**（踩坑 3）。

### 动画

`main/display/face_view.cc`，30fps `lv_timer`：

| 状态 | 动画 |
| --- | --- |
| 待命 | 4.2s 呼吸（±1.8px）+ 3.2s 眨眼（换 `neutral_blink` 图） |
| 进攻 | 两段：0.14s `attack_flat`（平眉）→ 0.38s `attack`（斜眉、直嘴），底色同步渐变 |
| 格挡 | 整图从 +40px 升起 240ms |
| 闪避 | 从右侧 40px 滑入 280ms + 残影淡入（160ms 后 260ms 淡出）+ `sin` 摆动衰减 |
| 受击 | 抖动 320ms 后回待命 |
| 大招就绪 | 形象 0.94–1.0 呼吸 |
| 胜利/失败 | 上跳 1500ms / 下沉 700ms 后常驻 |

### 音效

8 段 16kHz 单声道 ogg 放在 `main/assets/common/`，`scripts/gen_lang.py` 生成 `Lang::Sounds::OGG_READY/ATTACK/HURT/GUARD/DODGE/ULT/VICTORY/DEFEAT`，经 `AudioService::PlaySound` 与 TTS 共用解码队列（顺序播放，不混音）。

### MCP 与联调

- 设备侧注册 `self.hud.set_state` / `self.hud.get_state` / `self.hud.demo` / `self.hud.invert`（平台智能体可见）。
- USB Serial/JTAG 上另跑一套标准 MCP JSON-RPC（`initialize`、`tools/list`、`tools/call`），供本机联调；工具表与平台侧同名，另加 `hud.screenshot`（分块 base64 回传整屏，默认关闭）。
- 主机脚本：`hud/host/mcp_drive.py`（`info` / `set` / `demo` / `shots`；`_readline()` 跳过 ESP_LOG 行只认 JSON）。

### 面板与板级

- `SpiLcdDisplay` 保持部分刷新（`buffer_size = width*20`、`double_buffer=false`）；整屏 `full_refresh` 会卡死（踩坑 4）。
- 这块 ST7789 批次需要 INVOFF→INVON 校正：板级 `esp_lcd_panel_invert_color(panel, true)`，并提供运行时开关 `self.hud.invert` / `self.system.invert_colors`（写 NVS `display/ips_mode`）。
- 原厂 `PowerSaveTimer(-1, 60, 600)` 会在 10 分钟无操作后深睡（断 5V、USB 一起失联），联调版改为 `-1`，保留 60 秒降亮度。

## 踩坑记录

| # | 症状 | 原因 | 修法 |
| --- | --- | --- | --- |
| 1 | 烧录后彻底没输出：无日志、无 MCP、复位也不跑 | HUD 初始化写在 `LcdDisplay::SetupUI()` 里，那是 `Board::GetInstance()` 的构造过程；HUD 内部再取 Board 触发静态初始化重入，永久卡死 | 初始化挪到 `Application::Initialize()`，`board.GetDisplay()` 之后再启动 HUD |
| 2 | 屏幕只有底色在切换，看不到五官 | 设计稿导出把 8 个「背景色」矩形重命名成 `背景色1/2/3…`（还有 `ns1:id` 形式），按 id 删除只删掉一个，其余前景图整屏不透明 | 按属性值匹配删除背景矩形（任何 `id`/`ns1:id` 等于「背景色」的元素） |
| 3 | 前景图有了但表情仍不显示，探针显示 `w=0 h=0` | LVGL 内嵌 RLE 压缩图元解码不出尺寸（即便开了 `LV_BIN_DECODER_RAM_LOAD`） | 改用未压缩 `RGB565A8`，按内容裁剪控制体积 |
| 4 | LVGL 矢量表情在真机不可见、但 `lv_snapshot` 截图正常 | 部分刷新模式下 `lv_draw_sw_vector` 的 viewport 用绝对坐标、又按 `-buf_area` 平移，整屏矢量路径被裁到条带外；快照走整屏 layer 所以看起来正常 | 放弃矢量渲染，改预渲染位图；**不要**改成 `full_refresh`（整屏 PSRAM 缓冲 + 每帧 307KB ARGB 临时缓冲，实测把设备跑死） |
| 5 | 换表情后残留上一张的眉毛/火焰 | 新图尺寸比旧图小，旧像素没被覆盖 | 立即换图处 `lv_obj_invalidate(root)` 整屏重绘 |
| 6 | 残影对象存在但永远透明 | 创建时 `lv_obj_set_style_opa(obj, LV_OPA_TRANSP)` 把整对象透明度钉死为 0 | 用 `lv_obj_set_style_image_opa` 控制图片透明度，残影放在主图下层 |
| 7 | 进攻动画停在「平眉微笑」，第二段不动 | 第一段完成回调里用 `after != g_shown` 判断，`g_shown` 已是目标表情，条件永假 | 改成 `after >= 0` 直接走第二段 |
| 8 | 深绿显示成浅粉红、绿显示成品红 | 这块 ST7789 面板的 INVON/INVOFF 与驱动默认相反；反转发生在面板硬件，`lv_snapshot` 看不出来 | 初始化 `esp_lcd_panel_invert_color(panel, true)`，并保留运行时切换 |
| 9 | 截图数据横向彩条、字节错位 | 控制台 VFS 写是非阻塞的，15 万字节整帧直写会丢字节 | 分块 base64 行回传（每 1KB 一块）+ `WriteAll` 3s 超时丢弃 |
| 10 | `esptool read-mac`/`write-flash` 报 `No serial data received`，但设备明明在跑 | 应用占用 USB-Serial-JTAG，esptool 自带的 RTS 复位对本固件无效 | 用 pyserial 手动拨 `rts=True; dtr=False` 再放开进下载模式，或烧录脚本每 5s 重试 |
| 11 | 开机 10 分钟后设备「失联」，USB 还在但串口无响应 | 原厂 `PowerSaveTimer(-1, 60, 600)` 到点 `esp_deep_sleep_start()` 并断 5V | 联调版 `PowerSaveTimer(-1, 60, -1)`；唤醒需长按侧键或断电重上电 |

## 验证与证据

- 服务端：`pnpm typecheck`、`pnpm test`（`test/hud.test.ts` 与 `test/hud-http.test.ts` 覆盖待命帧、瞬时表情、大招三态、帧号去重、长轮询与通道工具面）。
- 真机：USB 连接后用 `hud/host/mcp_drive.py` 发 `initialize`/`tools/list`/`tools/call`；`self.hud.set_state` 驱动 8 表情与音效，`self.hud.get_state` 回读，`hud.screenshot` 抓整屏比对设计稿。**注意**：截图取自 LVGL 缓冲，看不到面板侧颜色反转，颜色必须人眼确认。
- 证据（仓库外）：`~/Documents/linx-hud-spike/evidence/`（`final_sheet.png` 8 状态总览、`device_*.png`、`mcp_transcript.jsonl`）、固件 `firmware/xiaozhi-hud-2.1.8.bin` 与 `xiaozhi-hud-2.1.8.patch`。

## 已知限制

- 固件按上游 v2.1.0 重建，丢掉了厂商私有工具 `self.system.set_aec`、`self.system.switch_TFT`；需要厂商源码才能补回。
- esp-sr 语音模型未随镜像打包，唤醒词暂不可用；HUD 与 MCP 不受影响。
- 设备通道已具备固件 HudClient（`battle_pull.cc`，NVS 配 `hud/url` 与 `hud/enabled`，默认关闭），尚未与平台真实链路联调；现阶段用 USB 上的 MCP 调用驱动。
- 闪避的「三张脸」按屏幕宽度做了取舍：现为单张主脸 + 残影摆动，与设计稿的三脸残影构图不完全一致。
- 设备绑定仍按 MAC：刷机后 `Client-Id` 会变，平台侧需要按新 MAC `e8:f6:0a:8b:f4:b4` 重新绑定。
