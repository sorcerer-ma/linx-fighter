# 固件实现说明：战斗 HUD（矢量设计稿 → 真机屏幕）

记录「把设计稿的 8 个表情 + 生命条 + 5 闪电 + 大招徽记 + 8 段音效，通过 MCP 驱动到 xiaozhi 设备屏幕」的最终实现与全部踩坑。对应固件版本 `2.1.8`，设备 `yunliao-s3`（ESP32-S3 / 8MB PSRAM / 16MB Flash）。

## 1. 总体结构

```
服务端（linx-fighter，/device/mcp 的 game_hud）
        │  ① 设备主动拉取（battle_pull，默认关闭）
        ▼
固件 battle_pull.cc ──► battle_hud_apply(state) ──► face_view（表情/动画）
                                          ├──► 资源行（爱心/血条/5 闪电）
                                          ├──► 大招徽记（三态）
                                          └──► 音效（AudioService::PlaySound）

本机联调：USB Serial/JTAG 上跑标准 MCP JSON-RPC（battle_ctl.cc）
        initialize / tools/list / tools/call → self.hud.set_state / get_state / demo / invert
```

- 显示层：官方「简单式」UI（`USE_DEFAULT_MESSAGE_STYLE`）里隐藏 `emoji_box_`、`top_bar_`、`status_bar_`、`bottom_bar_`，在 `screen` 上叠 HUD。
- 启动点：`Application::Initialize()` 中 `battle_hud_create(display); battle_ctl_start(); battle_pull_start();`。
- 状态锁定：HUD 收到过显式状态后置 `locked`，平台下发的情绪不再覆盖；`hud.unlock` 解除。

## 2. 资产管线（关键：不要用矢量渲染，也不要用 RLE）

设计稿是 8 个画板排成 4×2 的 SVG（每块 76.8×57.6，整张 `viewBox="0 0 308 116"`）。8 个导出文件内容完全相同，解析一份、按画板原点平移即可。

1. **单画板渲染**：把根节点 `viewBox`/`width`/`height` 改成该画板，`preserveAspectRatio="xMidYMid meet"`，用 Chrome headless 出 320×240 PNG：
   ```bash
   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu \
     --hide-scrollbars --force-device-scale-factor=1 \
     --window-size=320,240 --screenshot=out.png file://sheet.html
   ```
2. **透明前景**：复制一份 SVG，删掉背景色矩形，加 `--default-background-color=00000000`。背景色改由 LVGL 纯色绘制（切换时 300ms RGB 插值），这样底色渐变不占位图。
3. **按内容裁剪**：alpha>8 求包围盒 + 2px 边距。2.1.8 实测偏移/尺寸：
   `neutral (44,72,232,92)`、`neutral_blink (44,100,232,64)`、`attack_flat (44,48,232,116)`、`attack (44,47,232,109)`、`hurt (0,48,320,131)`、`guard (44,47,232,156)`、`dodge (44,47,232,117)`、`ultready (0,47,320,193)`、`victory (44,77,232,113)`、`defeat (44,81,232,78)`。
4. **转 C**：`scripts/Image_Converter/LVGLImage.py --ofmt C --cf RGB565A8 --compress NONE`；合并成 `face_assets.c/.h`，每个符号配 `FACE_<NAME>_X/_Y` 偏移宏，`face_view.cc` 摆放时叠加偏移。
5. **容量**：app 分区 4,032KB；未压缩前景约 840KB；2.1.8 镜像 3,799,792 字节（余量约 320KB）。

## 3. 动画参数（face_view.cc，30fps）

| 状态 | 实现 |
| --- | --- |
| 待命 | 呼吸 ±1.8px / 4.2s；每 3.2s 换 `neutral_blink` 眨眼 0.1s |
| 进攻 | 两段：0.14s `attack_flat`（平眉微笑）→ 0.38s `attack`（斜眉直嘴），底色同步渐变 |
| 格挡 | 整图从 +40px 升起 240ms |
| 闪避 | 从右侧 40px 滑入 280ms；残影 +28px、0.38 透明度、160ms 后 260ms 淡出；主脸 `sin(now/70)*11*decay` 摆动 |
| 受击 | 抖动 320ms，自动回待命 |
| 大招就绪 | 整脸 0.94–1.0 呼吸 |
| 胜利/失败 | 上跳 1500ms / 下沉 700ms |

双层 `lv_image`（`g_img[2]`）交叉淡入做状态切换，`g_ghost[2]` 做闪避残影；立即换图处必须 `lv_obj_invalidate(root)`。

## 4. 音效

8 段 16kHz 单声道 ogg 放 `main/assets/common/`，`scripts/gen_lang.py --language zh-CN --output main/assets/lang_config.h` 生成 `Lang::Sounds::OGG_READY/ATTACK/HURT/GUARD/DODGE/ULT/VICTORY/DEFEAT`；`Application::PlaySound` → `AudioService::PlaySound`，与 TTS 共用解码队列（顺序播放，不混音）。

## 5. MCP 与主机工具

- 设备端 MCP（平台可见）：`self.hud.set_state`、`self.hud.get_state`、`self.hud.demo`、`self.hud.invert`、`self.hud.pull`、`self.hud.link`。
- 串口 MCP（USB Serial/JTAG，本机联调用）：同名三件 + `hud.screenshot`（分块 base64 回传，默认不编入）。
- 主机脚本 `scripts/mcp_drive.py`（pyserial）：
  ```bash
  python3 mcp_drive.py info                 # initialize + tools/list + get_state
  python3 mcp_drive.py set hurt 6 10 2 5 1 hurt 1500
  python3 mcp_drive.py demo                 # 8 表情轮播
  ```
  读取时 `_readline()` 只接受可解析 JSON 行，自动跳过 ESP_LOG。

## 5.1 推送取帧（2.3.0）

默认由服务端 WebSocket 主动推帧，轮询只作兜底。

- `main/display/battle_link.cc`：`NetworkInterface::CreateWebSocket(1)` 连 `/device/ws`，`OnData` 把整行 JSON 交给 `battle_pull_apply_json()`（与轮询共用 seq 去重与渲染，不会重复播效）。
- 配置存 NVS `hud/ws_url` + `hud/ws_on`；串口/平台工具 `self.hud.link {"url":"ws://host:port/device/ws","enabled":true}`，地址缺 `device=` 时自动补 STA MAC；启用推送会顺手关掉轮询。
- 连上先收当前帧；之后服务端 200ms 检查、`seq` 变才推。设备侧 3s 重连、20s ping；设备状态机处于 starting/wifi_configuring/activating/upgrading/audio_testing 时先不发包（否则 lwIP 未就绪会 `tcpip_send_msg_wait_sem` 断言、屏幕黑白闪）。
- 真机验证（2026-10-31）：握手后立即渲染待命帧；一局内依次收到 `hurt → hurt → attack → defeat`，6 秒后自动回待命并收起资源；`get_state` 的 `seq` 与服务器一致。

## 6. 板级改动（yunliao_s3.cc）

| 改动 | 原因 |
| --- | --- |
| `PowerSaveTimer(-1, 60, -1)` | 原厂 `600` 秒后深睡并断 5V，USB 一起失联 |
| `Settings("display").GetBool("ips_mode", true)` + `esp_lcd_panel_invert_color` | 这块屏 INVOFF 时颜色反相（深绿→浅粉红） |
| 新增 `self.system.invert_colors` 运行时开关 | 不同批次 ST7789 的 INVON/INVOFF 相反，现场可切换 |
| `display/panel_ctrl.{h,cc}` | 串口/工具侧访问面板句柄，切反色不用重编 |

## 7. 踩坑

### 7.1 启动即死锁（最坑）

症状：烧录后无日志、无 MCP、复位也不跑，但原厂镜像正常。
原因：HUD 初始化写在 `LcdDisplay::SetupUI()` 里，那是 `Board::GetInstance()`（`main/boards/common/board.h` 的静态局部变量）构造过程的一部分；HUD 内部 `HudLock` 再取 Board，触发静态初始化保护重入，永久卡死。
修法：`SetupUI()` 只做隐藏控件，HUD 初始化放 `Application::Initialize()`。

### 7.2 只有底色在变，看不到表情

两层原因叠加：
1. 设计稿导出把 8 个「背景色」矩形重命名成 `背景色1/2/3…`（还有 `ns1:id` 形式）。按 `id == "背景色"` 删除只删掉一个，其余 7 张前景图整屏不透明 → 看起来就是「只有底色切换」。修法：属性值等于「背景色」的元素一律删（含命名空间前缀）。
2. 即使前景透明，LVGL 内嵌 **RLE** 图元解码失败（探针 `w=0 h=0`，`LV_BIN_DECODER_RAM_LOAD=y` 也没用）。修法：`--compress NONE` + 按内容裁剪。

### 7.3 矢量渲染在真机不可见，但快照正常

LVGL 9.3 软件矢量（ThorVG）在部分刷新模式下：`lv_refr.c` 把 `layer->buf_area` 设成条带，而 `lv_draw_sw_vector.c` 的 viewport 用绝对坐标、又按 `-buf_area` 平移，整屏矢量路径被裁到条带外。`lv_snapshot` 走整屏 layer，所以截图看着完全正常 —— **不要用快照证明面板能显示**。
尝试过整屏刷新（`buffer_size = width*height`、`full_refresh=1`）：PSRAM 整屏缓冲 + 每帧 307KB ARGB 临时缓冲，设备直接卡死不响应，已回退。
结论：表情走预渲染位图，背景走 LVGL 纯色。

### 7.4 颜色反相（深绿 → 浅粉红、绿 → 品红）

面板 `INVON/INVOFF` 与驱动默认相反，反转发生在面板侧，快照看不出来。`#1A4038` 取反是 `#E5BFC7`（浅粉红），与现象吻合。
修法：初始化 `esp_lcd_panel_invert_color(panel, true)`；保留 `self.hud.invert` / `self.system.invert_colors`。

### 7.5 换图残影

新图比旧图小，旧像素没被覆盖。修法：`ShowImmediate()`、眨眼换图处 `lv_obj_invalidate(root)`。

### 7.6 残影永远透明

创建时 `lv_obj_set_style_opa(ghost, LV_OPA_TRANSP, 0)` 把整对象透明度钉死；后续改的是 `lv_obj_set_style_opa` 也没用（被覆盖顺序影响）。修法：用 `lv_obj_set_style_image_opa` 控制图片透明度，并把残影放在主图下层。

### 7.7 进攻两段动画只剩第一段

完成回调 `if (after >= 0 && after != g_shown)`，而 `g_shown` 已更新成目标表情，条件永假。修法：`if (after >= 0)`。

### 7.8 截图彩条 / 字节错位

控制台 VFS 写非阻塞，15 万字节整帧直写会丢。修法：base64 行分块（每 1KB 一块）+ `WriteAll` 3 秒超时丢弃剩余。

### 7.9 esptool 连不上设备

应用占用 USB-Serial-JTAG，esptool 自带 RTS 复位无效（`No serial data received`）。修法：pyserial 手动拨 `rts=True; dtr=False` 再放开进下载模式；或烧录脚本每 5s 重试。

### 7.10 十分钟后设备「失联」

原厂 `PowerSaveTimer(-1, 60, 600)` 到点 `esp_deep_sleep_start()` 并断 5V；USB 仍枚举但 CPU 不响应。修法：`-1`；唤醒需长按侧键或断电重上电。

## 8. 从零复现

```bash
# 1) 取上游 v2.1.0（含 yunliao-s3 板级）
curl -L -o /tmp/xiaozhi-v2.1.0.tar.gz \
  https://codeload.github.com/78/xiaozhi-esp32/tar.gz/refs/tags/v2.1.0
mkdir -p /tmp/fwsrc && tar -xzf /tmp/xiaozhi-v2.1.0.tar.gz -C /tmp/fwsrc

# 2) 应用补丁 + 覆盖成品文件
cd /tmp/fwsrc && patch -p1 < ~/Documents/linx-hud-spike/firmware/xiaozhi-hud-2.1.8.patch
cp ~/Documents/linx-hud-spike/firmware/files/{battle_assets.c,battle_assets.h,battle_hud.cc,battle_hud.h, \
   battle_ctl.cc,battle_pull.cc,battle_pull.h,face_assets.c,face_assets.h,face_view.cc,face_view.h, \
   panel_ctrl.cc,panel_ctrl.h} xiaozhi-esp32-2.1.0/main/display/
cp ~/Documents/linx-hud-spike/firmware/files/*.ogg xiaozhi-esp32-2.1.0/main/assets/common/

# 3) 配置与编译（ESP-IDF v5.4.1）
cat > xiaozhi-esp32-2.1.0/sdkconfig.defaults.local <<'EOF'
CONFIG_BOARD_TYPE_YUNLIAO_S3=y
CONFIG_USE_DEVICE_AEC=y
CONFIG_OTA_URL="https://xrobo.qiniuapi.com/v1/ota/"
CONFIG_FLASH_NONE_ASSETS=y
CONFIG_ESP_CONSOLE_USB_SERIAL_JTAG=y
CONFIG_LV_USE_SNAPSHOT=y
CONFIG_LV_BIN_DECODER_RAM_LOAD=y
CONFIG_LV_CACHE_DEF_SIZE=4194304
EOF
source /tmp/spike/env.sh   # 手工拼的 IDF 环境（export.sh 缺 riscv32 会报错）
cd xiaozhi-esp32-2.1.0
idf.py -D SDKCONFIG_DEFAULTS="sdkconfig.defaults;sdkconfig.defaults.esp32s3;sdkconfig.defaults.local" \
  set-target esp32s3
idf.py build

# 4) 烧录（只覆盖 ota_0，保留 NVS 与 8MB assets 分区）
/tmp/linxvenv/bin/esptool --chip esp32s3 -p /dev/cu.usbmodem2101 -b 460800 \
  write-flash --flash-mode dio --flash-size 16MB --flash-freq 80m \
  0x20000 build/xiaozhi.bin
```

回滚：`esptool write-flash 0x20000 backup/ota0-original.bin`（原厂 4,128,768 字节，整片备份 `backup/full-16mb.bin`）。

## 9. 验收清单

- [ ] 屏幕上 8 个表情都能显示，且与设计稿一致（颜色：深墨绿底 / 浅豆绿五官 / 棕腮红）。
- [ ] 待命在眨眼，进攻有「平眉→斜眉+直嘴」两段，格挡举盾，闪避滑入带残影，胜利上跳，失败下沉。
- [ ] 生命条随 hp 变长（≤30% 变橙），5 个闪电按能量点亮，大招徽记三态可辨。
- [ ] `mcp_drive.py set hurt 6 10 2 5 1 hurt 1500` 能切到受击并出声。
- [ ] 断网/重启后仍正确（NVS 保存 `display/ips_mode`）。


## 6. 2.4.x：日常表情、系统界面与功能裁剪

### 6.1 日常对话表情（2.4.0）

- 4 张新表情（吃惊/飞吻/思考/休眠）走同一套位图管线：`faces4/gen.py` 把每个 SVG 拆成「脸」与「特效」两组，Chrome headless 渲染成 320×240 透明 PNG，按 alpha 裁剪。
- 空间不够（ota_0 只剩约 72KB），因此 4 张脸烘焙 `#1A4038` 底色转 RGB565，6 个特效保留 RGB565A8；生成器产出的 map 必须加 `const`，否则会落进 `.data` 把 DRAM 撑爆（`dram0_0_seg overflowed`）。
- 特效动效在 `face_view.cc::UpdateFx()`：感叹号弹入、爱心上飘、问号轻晃、Z 字错峰上浮；**每帧先 `HideAllFx()` 再按需显示**，否则切换表情会残留上一组特效。
- 全屏底色必须用 24 位 `0xRRGGBB`（`lv_color_hex` 的入参），给 RGB565 数值会变成奇怪的蓝色；底色要和位图烘焙色的量化结果一致，否则出现矩形色块边界。
- 平台情绪映射在 `lcd_display.cc::HudExpressionFromEmotion()`，保留 0ms 停留时间以跟随整段回复；未收听（idle/配网/启动）显示休眠脸，收听/连接中显示待命脸。

### 6.2 系统界面让位（2.4.2）

- 配网/激活/升级这些系统界面用原始状态栏显示提示文字，而战斗 HUD 是全屏图层会盖住它。`Display` 新增 `virtual void ShowSystemUi(bool)`，`LcdDisplay` 覆写为「显示状态栏 + `battle_hud_set_overlay_visible(false)`」。
- 由 `battle_hud.cc` 的 `StateFaceTask` 每 200ms 根据 `Application::GetDeviceState()` 切换；离开这些状态后 HUD 自动恢复。

### 6.3 开机不再自检 + 删除音频回放（2.4.2）

- 去掉 `battle_hud_create()` 里「3 秒后自动 `battle_demo_start()`」的逻辑，开机直接进入正式画面（需要演示仍可用 `self.hud.demo`，演示结束自动回到闲聊态并收起资源）。
- 删除原厂「配网状态下点按 BOOT 键把麦克风录下来的声音再播一遍」的功能：移除 `kDeviceStateAudioTesting` 状态、`AudioService::EnableAudioTesting()`、`audio_testing_queue_`、编码任务里的测试队列分支，以及状态机/三套 LED/网络闸门里的相关分支。

### 6.4 配网模式必须有出口（2.4.4）

删掉音频回放后，配网状态下的单击变成空操作、三击又被 `EnterWifiConfigMode()` 拒绝，导致用户卡在配网界面既不能对话也不能再进设置。

修法：
- `Board` 新增 `virtual void ExitWifiConfigMode()`，`WifiBoard` 实现为 `in_config_mode_ = false; WifiManager::GetInstance().StartStation(); SetDeviceState(kDeviceStateIdle);`（`StartStation()` 会顺带关掉配网 AP 并用 NVS 凭据重连）。
- 状态机允许 `wifi_configuring → idle`。
- 云聊板按键：单击在配网状态直接退出；三击在「进入配网 / 退出配网」之间切换。
- 串口另留 `hud.cfg {"enable":true|false}` 便于远程进出配网。

## 7. 表情资源压缩（2.5.0）

- 背景：app 分区 4,128,768 字节，2.4.7 镜像 4,055,440 字节，只剩 73,328 字节，再加一个表情就放不下。
- 做法：表情/特效前景全部改用 LVGL RLE 压缩（`LVGLImage.py --compress RLE`），Kconfig 打开 `CONFIG_LV_USE_RLE=y`。
  - `RGB565A8` 的 RLE 按 2 字节单元处理（颜色平面 + 透明平面连续），与 `Image_Converter` 的 `blk_size=(bpp+7)//8` 对齐；
  - 4 个日常表情把底色 `#1A4038` 烘进图里用 `RGB565`，进一步省掉透明平面。
- 结果：`face_assets.c` 的 rodata 1.12MB → 约 0.20MB；镜像 3,135,392 字节；app 分区余量 993,376 字节（+920,048）。
- 复现：`assets/2.5.0/` 里是 31 张中间 PNG，`scripts/gen_face_assets_rle.py <png目录> <工程 main/display>` 能逐字节复现 `face_assets.c`。
- 踩坑：
  1. `CONFIG_LV_USE_RLE` 未开时，`lv_bin_decoder` 对 RLE 图直接返回 invalid，`lv_image` 拿到 `w=0 h=0`，屏幕上只剩底色——不是尺寸/偏移问题；
  2. `face_assets.c` 里不能重复生成 6 个图标，它们由 `battle_assets.c` 提供，否则链接报 `multiple definition of 'icon_heart'`；
  3. 生成的 `xxx_map[]` 必须是 `static const`，否则掉进 `.data` 触发 `dram0_0_seg overflowed`；生成器那种「`static const` 单独一行 + 属性行 + `uint8_t` 行」的拆分写法要整段保留。
- 还没做的优化（留给以后）：
  - 字体子集化：`xiaozhi-fonts` 里最大的三个字模约 90KB / 56KB / 25KB，按实际用字裁剪能省 100KB+，但 Wi-Fi 名等运行时文本可能缺字，风险高；
  - 裁剪未用组件（`esp_emote_gfx`、`image_player` 等）：需改 `main/idf_component.yml` 和源码条件编译，预估 30–60KB；
  - 关断言/降日志等级：能省几十 KB，但会丢掉崩溃现场，不建议在联调期做。

### 6.5 重击锤子弧线（2.5.4）

- 目标：重击时**脸保持不动**，只有锤子沿弧线挥下（用户明确「脸和锤子分开」）。
- 做法：把「脸 + 挥击弧线 + 锤子」按同一坐标系预渲染成 7 张整图；`face_view.cc` 的 `kHeavyFrames[7]` 存指针，`kHeavySwingMs = 380`，切到 `kFaceHeavy` 时 `ShowImmediate` 后从第 0 帧开始，`TickCallback` 每帧按 `elapsed * 7 / 380` 换 `g_img[g_top]` 的 src，落定停第 6 帧。
- 关键点：脸在 7 张图里像素位置完全一致，所以画面上只有锤子变化；整帧方案不新增任何 widget，避开了「新建锤子图层导致开机卡死」的坑。
- 素材与生成：`design/svg/heavy-swing/`（7 个旋转角度 + 整帧 SVG）、`design/assets/2.5.2/heavy*.png`；`scripts/gen_face_assets_rle.py` 的 `ASSETS` 已含这 8 项。
