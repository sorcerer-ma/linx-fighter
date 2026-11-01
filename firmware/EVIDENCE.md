# 固件 HUD 真机验证记录（2026-10-31 05:30）

## 结论

在真机（ESP32-S3，板型 yunliao-s3，MAC e8:f6:0a:8b:f4:b4）上，基于上游 xiaozhi-esp32 v2.1.0 + ESP-IDF v5.4.1 重编的固件已经跑通：

1. **8 种表情**全部能在 320×240 屏上显示（见 `device_overview.png`）；
2. **生命条（爱心 + 绿色辅助条，无数值）**、**5 个能量闪电（黄色实心/灰色空心）**、**右上角大招徽记三态**（未就绪/可释放/已用）随状态实时变化；
3. **8 段音效**已编进固件（`main/assets/common/*.ogg`），状态变化时经 `AudioService::PlaySound` 播报（串口日志可见 OpusHead/重采样），每段 0.24–1.46 秒；
4. 状态可以通过 **MCP 工具**驱动：`self.hud.set_state` / `self.hud.get_state` / `self.hud.demo`，与平台端设备 MCP 协议一致（JSON-RPC 2.0，`initialize`/`tools/list`/`tools/call`）。

## 真机证据

- `device_overview.png`：8 张纯设备截屏（由固件 `hud.screenshot` 通过串口回传 RGB565 原图，不是电脑渲染稿）。
- `device_<state>.png`：单张原始截屏。
- 开机自检：上电 3 秒后自动轮播 8 表情 + 音效各 900ms，方便肉眼确认。
- 日志（节选）：`BattleHud: HUD created`、`BattleCtl: HUD MCP tools registered`、`cue=attack/hurt/guard/dodge/...`、`AudioService: OpusHead`。
- MCP transcript：`/tmp/hud/evidence/mcp_transcript.jsonl`。

## 这张固件的限制（重要）

- 原厂固件里的**厂商私有 MCP 工具** `self.system.set_aec`、`self.system.switch_TFT` 在这个上游基线上不存在，刷入后即丢失。
- 为了绕过 esp-sr 133MB 组件下载损坏（zip 的 model 段坏了），**语音唤醒模型未编进本固件**：串口有 `E MODEL_LOADER: Can not find model in partition table`，语音唤醒/识别暂不可用；HUD 与 MCP 不受影响。恢复办法：重新完整下载 esp-sr 组件（含模型）后重编。
- 平台侧尚未接入：设备已连上 WiFi（AP「Simon 15」），但 HUD 状态目前来自串口/MCP 自检，尚未由服务端战斗状态驱动（下一步）。
- 原厂 `assets` 分区与 NVS 未改动；`sdkconfig.defaults.local` 里 `CONFIG_OTA_URL` 已指向 `https://xrobo.qiniuapi.com/v1/ota/`，但固件版本已被我抬到 `2.1.1`，平台 OTA 不会把这份固件降级覆盖。

## 回滚方法（恢复到出厂 2.1.0）

```bash
/tmp/linxvenv/bin/esptool --chip esp32s3 -p /dev/cu.usbmodem2101 -b 460800 \
  write-flash --flash_mode dio --flash_size 16MB --flash_freq 80m \
  0x20000 /tmp/linx-backup/ota0-original.bin
```

整片备份：`/tmp/linx-backup/full-16mb.bin`（16MB）。

## 复现步骤

1. 构建：`source /tmp/spike/env.sh && cd /tmp/fwsrc/xiaozhi-esp32-2.1.0 && idf.py build`
2. 烧录：上一条命令里的 `build/xiaozhi.bin` 写到 `0x20000`（只覆盖 ota_0）
3. 验证：`/tmp/linxvenv/bin/python /tmp/hud/host/mcp_drive.py shots`（会采集 8 张截屏到本目录）

## 关键代码位置（工程 `/tmp/fwsrc/xiaozhi-esp32-2.1.0`）

| 内容 | 文件 |
| --- | --- |
| HUD 渲染（表情/生命条/闪电/徽记/动画定时器） | `main/display/battle_hud.cc`、`battle_hud.h` |
| 位图资源（14 个 lv_image_dsc_t，未压缩，约 660KB） | `main/display/battle_assets.c`、`battle_assets.h` |
| MCP 工具与串口 JSON 通道（含截屏） | `main/display/battle_ctl.cc` |
| 接入点（隐藏原界面、启动 HUD） | `main/display/lcd_display.cc`、`main/application.cc` |
| 音效 | `main/assets/common/{ready,attack,hurt,guard,dodge,ult,victory,defeat}.ogg` |
| 编译配置 | `sdkconfig.defaults.local` |

---

## 2026-10-31 05:50 补充（设备深睡与加固版）

### 05:26 之后为什么连不上

不是刷坏，也不是固件死锁。原厂板级 `main/boards/yunliao-s3/yunliao_s3.cc:27` 写了 `PowerSaveTimer(-1, 60, 600)`：开机约 10 分钟无操作就调用 `PowerManager::Sleep()`，`power_manager.cc:187` 打印 `Entering deep sleep` 后 `esp_deep_sleep_start()`，同时关掉 5V——USB 随之掉线，`esptool` 任何复位模式都连不上，但 macOS 仍会显示一个已失效的 `usbmodem` 节点。

唤醒：按住侧键（BOOT，GPIO2）约 2 秒到亮屏，或断电重上电。轻按一下会在启动 1 秒后被 `CheckStartup` 重新送去休眠。

### 加固版 2.1.2（已编译，未烧录）

- 关闭自动关机，保留 60 秒降亮度（`PowerSaveTimer(-1, 60, -1)`），长按侧键仍可主动休眠；
- 串口写加 3000ms 超时，超时丢弃剩余字节并 `ESP_LOGW`，不再无限重试；
- 截屏命令 `hud.screenshot` 默认不编入（整帧 15 万字节大块写，主机中途断开有卡死风险），需要时改 `HUD_ENABLE_SCREENSHOT 1`；
- 产物 `firmware/xiaozhi-hud-2.1.2.bin`（3,539,264 字节，app 分区余量 14%）。

### 期望的唤醒后验证顺序

1. 烧 `xiaozhi-hud-2.1.2.bin` 到 0x20000；
2. 等 3 秒看开机自检是否轮播 8 表情并出声；
3. `mcp_drive.py set hurt 6 10 2 5 1 hurt 1500` 看屏幕与音效；
4. 放着不动 >10 分钟，确认不再深睡（这是 2.1.2 与 2.1.1 的关键差异）。

### 2.1.4：HudClient（已编译，未真机联调）

- 固件新增 `main/display/battle_pull.{h,cc}`：后台任务每 ~1.2 秒 POST 一次 `tools/call`（`game_hud`，`wait_ms=1500`）到服务端 `/device/mcp`，带 `X-Linx-Device-Id: e8:f6:0a:8b:f4:b4`；按 `seq` 去重后调用 `battle_hud_apply` 渲染，失败只打限频日志并保留上一帧。
- 配置走 NVS（命名空间 `hud`）：`url` 与 `enabled`，默认关闭、空地址；串口 MCP 工具 `self.hud.pull`（`url`、`enabled`）用于设置，写入后重启仍生效。
- 版本抬到 `2.1.4`；镜像 `firmware/xiaozhi-hud-2.1.4.bin`，3,547,568 字节；app 分区余量 14%。截图命令在 2.1.4 重新编入（分块 base64 + 3 秒超时保护），用于联调取证。
- 服务端已用 curl 实测（本机 8000 端口，`feat/device-hud` 分支）：
  - 空对局：`{"battle":false,"expression":"neutral","hp":0,"max_hp":1,"energy":0,"max_energy":5,"ult":0,"seq":1}`
  - `POST /debug/start?device=e8:f6:0a:8b:f4:b4&agent=hud-demo` 后：`{"battle":true,"hp":18,"max_hp":18,"energy":3,"seq":1}`
  - `POST /debug/action` 说「闪避」被强攻命中后：`{"expression":"hurt","hp":13,"energy":2,"cue":"hurt","seq":2,"hold_ms":2500}`
- 注意：服务端要求请求头 `Accept: application/json, text/event-stream`，否则返回 -32000；固件已按此发送。
- 待验证：设备与 Mac 是否同网段（Mac `en0 = 10.158.71.59`，默认路由走 VPN `utun4`）。


## 2.3.0 推送链路验收（2026-10-31 22:0x）

- `link_prod.png`：设备切到正式环境 `ws://111.62.156.213:10659/device/ws` 后拉到的待命帧。
- `ws_start.png` / `ws_end.png` / `ws_after.png`：一局从开始到结束再到 7 秒后收回资源。
- `e2e_hurt.png` / `e2e_victory.png` / `e2e_idle.png`：真实对局中按需抓拍（受击 X 眼、胜利、闲聊态只剩表情）。
- `settled_end.png` / `settled_idle.png`：结局定格与随后回待命。
- `fade_defeat_t1.png`：表情交叉淡入 1.2 秒后的稳定帧（验证换脸不会叠加）。
- 设备 `self.hud.get_state` 与服务器帧号一致（`seq` 递增、`battle` 切换正确）。
