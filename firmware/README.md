# 设备 HUD 固件（Yunliao-S3）

这里是「共鸣：闻声对决」配套硬件（YunLiao S3 开发板）上运行的固件源码快照、历史镜像与构建产物，以及配套的设计资产和脚本。

固件基于开源项目 [xiaozhi-esp32](https://github.com/78/xiaozhi-esp32) `v2.1.0`（MIT License，见 `src/LICENSE`）改造，板级为 `yunliao-s3`。相对上游的主要改动：全屏矢量/位图表情舞台、双人资源条、大招徽记、12 种表情与动作特效、设备侧 HUD 数据通道（WebSocket 推送 + HTTP 拉取兜底）、系统界面让位、音频回放等无用能力裁剪。

## 目录

| 路径 | 内容 |
| --- | --- |
| `src/` | 可直接构建的完整源码（上游 `v2.1.0` + 本项目改动，已含生成好的位图资源） |
| `bin/` | 历史版本的固件镜像（`xiaozhi-hud-<版本>.bin`，烧到 `0x20000`） |
| `patch/` | 每个镜像对应的源码补丁（对干净的上游 `v2.1.0`，用 `patch -p1` 打） |
| `design/svg/` | 12 个表情的原始 SVG 设计稿 |
| `design/2.5.0/` | 2.5.0 版位图资源管线的中间产物（31 张 PNG） |
| `scripts/` | 资产生成、设备驱动、回滚等脚本 |
| `ARCHIVE.md` | 版本归档明细（镜像指纹、变更、验证结果、回滚命令） |
| `IMPLEMENTATION.md` | 实现说明（显示栈、资产管线、动画参数、踩坑记录） |
| `EVIDENCE.md` | 真机验证记录与截图位置 |
| `OVERNIGHT-2.5.0.md` | 2.5.0（RLE 压缩）的优化记录 |

未纳入本目录的内容：

- `build/`、`managed_components/`、`components/`（构建产物与第三方组件，按需下载）；
- `sdkconfig`（生成文件）——构建配置见 `src/sdkconfig.defaults*`；
- 整机 flash 备份与 NVS（含 Wi-Fi 凭据等，不入库）；
- esp-sr 语音模型（体积大，运行时从设备 assets 分区读取）。

## 版本

| 版本 | 要点 |
| --- | --- |
| 2.1.1–2.1.8 | 单表情验证 → 8 种战斗表情 + 生命条/能量/大招徽记 + 音效 + 设备 MCP 工具 |
| 2.1.9–2.2.3 | 双人两行资源条、双大招徽记、对局结束定格、崩溃修复 |
| 2.3.0 | 服务端 WebSocket 推送取帧（`/device/ws`） |
| 2.4.0–2.4.4 | 4 个日常表情（吃惊/飞吻/思考/休眠）+ 特效、情绪映射、系统界面让位、删除音频回放、配网出口 |
| 2.4.7 | 大招就绪新图 + `angry → 大招就绪` + ult 音量下调 |
| 2.5.0 | 表情资源改 LVGL RLE 压缩，镜像 4,055,440 → 3,135,392 字节，分区余量 72KB → 约 970KB |
| 2.5.3 | 蓄力/重击各自一张表情（蓄力=闪电眼；重击=「格挡 + 战锤」，用户调过锤头角度），服务端同一回合先播我方出手再播对手还手 |
| 2.5.1 | 大招徽记换成新版三态图标（未就绪=双环、可释放=火焰+实心核心、已用=半透明白斜划），位置对齐到 `(6,2)` / `(284,2)` |

镜像与补丁的对应关系、sha256 指纹与回滚命令见 `ARCHIVE.md`。

## 构建

需要 ESP-IDF `v5.4.x`（与设备上的 `5.4.1` 对应）。

```bash
cd src
idf.py -D SDKCONFIG_DEFAULTS="sdkconfig.defaults;sdkconfig.defaults.esp32s3;sdkconfig.defaults.local" set-target esp32s3
idf.py build
```

说明：

- `sdkconfig.defaults.local` 里已固定板型（`CONFIG_BOARD_TYPE_YUNLIAO_S3`）、AEC、OTA 地址、`CONFIG_FLASH_NONE_ASSETS=y`、`CONFIG_LV_USE_RLE=y`、显示快照等关键项；
- 首次构建会从组件仓库下载托管组件（LVGL、esp-sr 等，数百 MB），网络不稳时先 `idf.py reconfigure` 再重试；
- 如果机器上已有 esp-sr 解压目录，可放到 `components/espressif__esp-sr` 并从 `src/main/idf_component.yml` 删除对应依赖，避免重复下载。

## 烧录与回滚

设备通过 USB-C 连接，串口通常是 `/dev/cu.usbmodem2101`。

```bash
# 烧录（只覆盖 ota_0 的应用分区，不动分区表/NVS/assets）
esptool --chip esp32s3 -p /dev/cu.usbmodem2101 -b 460800 \
  write-flash --flash_mode dio --flash_size 16MB --flash_freq 80m \
  0x20000 bin/xiaozhi-hud-2.5.3.bin

# 回滚到任意历史版本
esptool --chip esp32s3 -p /dev/cu.usbmodem2101 -b 460800 \
  write-flash --flash_mode dio --flash_size 16MB --flash_freq 80m \
  0x20000 bin/xiaozhi-hud-2.4.7.bin
```

注意：

- 设备重启后如果屏幕是黑的，按一下侧边按键唤醒；长按会进入深睡；
- 应用接管 USB-Serial-JTAG 时 `esptool` 有时连不上，拔插 USB 后立刻重试，或用 `--before usb-reset`；
- 固件不会覆盖 assets 分区（原厂语音模型保留）。

## 与服务端的关系

设备通过 Wi-Fi/4G 连接服务端：

- 主通道：WebSocket `ws://<host>/device/ws?device=<MAC>`，服务端在有新画面时推送 JSON 帧（同 `game_hud` 工具输出）；
- 兜底：HTTP MCP `POST /device/mcp` 的 `game_hud` 工具轮询；
- 两者都只下发「画面帧」，对局裁决、数值与话术仍由服务端与平台智能体负责。

配置入口（串口 MCP 工具）：

- `self.hud.link {"url":"ws://…/device/ws","enabled":true}` 设置推送地址；
- `self.hud.pull {"url":"http://…/device/mcp","enabled":true}` 设置轮询地址（推送优先）；
- `self.hud.set_state` / `self.hud.get_state` / `self.hud.demo` / `self.hud.emotion` / `self.hud.invert` 调试用。

## 许可

上游 xiaozhi-esp32 为 MIT License，`src/LICENSE` 保留原始版权声明。本目录内的表情设计与相关文档由项目自持。
