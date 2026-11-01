## 2.5.0 归档（当前版本）

- 镜像：`xiaozhi-hud-2.5.0.bin`，3,135,392 字节，sha256 前 16 位 `fe293fa18567ea86`
- 补丁：`xiaozhi-hud-2.5.0.patch`（172,022 字节，对干净上游 v2.1.0，排除 `build/`、`managed_components/`、`components/`、`sdkconfig`、生成位图 `face_assets.c`、`battle_assets.c`、`lang_config.h`）
- 变化：
  1. 表情/特效前景全部改为 LVGL RLE 压缩（`CONFIG_LV_USE_RLE=y`），`face_assets.c` 的 rodata 从约 1.12MB 降到约 0.20MB；
  2. 镜像 4,055,440 → 3,135,392 字节（少 920,048），app 分区（4,128,768）余量 73,328 → 993,376 字节；
  3. 功能与 2.4.7 保持一致，无行为变化。
- 资产与重建：`assets/2.5.0/` 存 31 张中间 PNG；`scripts/gen_face_assets_rle.py` 可从这些 PNG 复现 `face_assets.c`（实测与本版本逐字节一致）。
- 本地验证：12 表情 + 4 特效全部正常（`evidence/rle_sheet.png`）、双行资源与双徽记正常（`rle_dual.png`）；72+48 帧表情切换压测无重启、无 assert，free sram 稳定在 43KB 上下（minimal 39.7KB）；开机日志 `App version: 2.5.0`、`HUD created: 12 expressions`、`BattleLink: link connected`。
- 回滚：`esptool ... write-flash 0x20000 xiaozhi-hud-2.4.7.bin`。

## 2.4.7 归档

- 镜像：`xiaozhi-hud-2.4.7.bin`，4,055,440 字节，sha256 前 16 位 `58ef378ebde3f604`
- 补丁：`xiaozhi-hud-2.4.7.patch`（172,001 字节，对干净上游 v2.1.0，排除 `build/`、`managed_components/`、`components/`、`sdkconfig`、生成位图 `face_assets.c`、`battle_assets.c`、`lang_config.h`）
- 相对 2.4.4 的变化：
  1. 新增 `main/display/gesture_hint.{h,cc}`：`飞吻/亲吻/亲亲/么么/啵啵/吧唧/吻我/mua` 等关键词 → `kissy`；`application.cc` 在 `stt`（用户原话）与 `llm`（回复文本）里命中后 10 秒内优先于平台情绪；
  2. 串口 MCP 新增 `self.hud.gesture`（按文本识别动作并切表情）；
  3. 「大招就绪」底图按用户更新后的 `大招就绪.svg` 重新渲染（火焰细节变化，尺寸/偏移仍为 320×193 @ y=47）；
  4. `HudExpressionFromEmotion()` 把 `angry` 从 `defeat` 改为 `ultready`（sad/crying/embarrassed 仍为 defeat）；
  5. `main/assets/common/ult.ogg` 音量下调（mean -11.5dB → -18.4dB，peak -1.4dB → -8.3dB），其余 7 段音效未动。
- 本地验证：`self.hud.emotion {"name":"angry"}` 显示新火焰大招脸；`self.hud.gesture {"text":"请给我一个吻"}` 返回 `{"ok":true,"hint":"kissy"}` 并显示单眼眨眼 + 爱心；开机进入休眠脸、无自检演示。

# 归档：xiaozhi-hud-2.3.0（2026-10-31）

## 结论

设备侧三件事已经真机跑通，并已切到正式环境（`111.62.156.213:10659`）的 WebSocket 推送：

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| 8 种表情 + 大招 + 生命值 + 能量 | ✅ | 全屏矢量稿转位图 + 逐帧动画；双行资源；双大招徽记 |
| 状态对应音效 | ✅ | 7 段 16kHz Opus（待命静默），频谱互不重叠 |
| 状态由 MCP 驱动 | ✅ | 服务端派生事实 → `/device/ws` 推送；拉取 `/device/mcp` 保留兜底 |

## 版本指纹

- 固件：`xiaozhi-hud-2.3.0.bin`，3,831,232 字节，sha256 前 16 位 `9f51994e10954b0d`
- 补丁：`xiaozhi-hud-2.3.0.patch`（对上游 `78/xiaozhi-esp32` v2.1.0，不含生成的位图与 sdkconfig）
- 编译：ESP-IDF v5.4.1，`PROJECT_VER = 2.3.0`

## 设备侧关键改动（相对 2.2.3）

1. 新增 `main/display/battle_link.{h,cc}`：连服务端 `/device/ws`，收到帧交给 `battle_pull_apply_json()`；断线 3s 重连、20s ping。
2. `battle_pull.{h,cc}` 暴露 `battle_pull_apply_json()`，与拉取共用 seq 去重与渲染。
3. 串口/平台工具新增 `self.hud.link`（`url` + `enabled`），启用推送时自动关掉拉取。
4. `application.cc` 启动序列加入 `battle_link_start()`。

## 已知限制

- 设备 NVS 里保存的推送地址是公网 `ws://111.62.156.213:10659/device/ws`，服务停机时会保留最后一帧。
- 平台侧尚未按新 MAC 绑定智能体；本轮验收走的是服务端 MCP 直连。
- 厂商私有工具 `self.system.set_aec` / `self.system.switch_TFT` 不在上游基线里。
- 表情资产由设计稿 SVG 经 Chrome 渲染成位图，RLE 压缩在设备上解不出来，必须 `--compress NONE`。

## 保密约定

本目录与仓库内分支均**未推送**到 GitHub；按当前要求仅本地归档。
---

## 2.4.4 归档

- 镜像：`xiaozhi-hud-2.4.4.bin`，4,054,464 字节，sha256 前 16 位 `22ea37dd34bc880d`
- 补丁：`xiaozhi-hud-2.4.4.patch`（164,262 字节，对干净上游 v2.1.0，排除 `build/`、`managed_components/`、`components/`、`sdkconfig`、生成位图 `face_assets.c`、`battle_assets.c`、`lang_config.h`）
- 相对 2.3.0 的变化：
  1. 新增 4 个日常表情（吃惊/飞吻/思考/休眠）与感叹号/爱心/问号/Z 特效动画，平台 21 种情绪 → 12 张脸；
  2. 未收听显示休眠脸、收听/连接显示待命脸；
  3. 去掉开机自检演示（`self.hud.demo` 仍可手动触发，结束自动回闲聊态）；
  4. 配网/激活/升级时战斗 HUD 让位，显示原始状态栏与顶栏；
  5. 删除原厂「配网时单击录音再回放」的 AudioTesting 功能；
  6. 补上配网出口：单击退出配网、三击进/出切换，`Board::ExitWifiConfigMode()`。
- 本地验证：4 张新脸 + 特效、蓝底/残影/状态覆盖三个 bug 已修；`self.hud.emotion` 验证 21→12 映射；`hud.cfg` 验证配网进出后能恢复对话与表情。
