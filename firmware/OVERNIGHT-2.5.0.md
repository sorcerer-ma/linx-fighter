# 夜间优化成果（固件 2.5.0）

## 一句话

固件从 **4,055,440 字节** 降到 **3,135,392 字节**，app 分区余量从 **72KB 提到约 970KB**，功能和 2.4.7 完全一致；已在真机上验证 12 个表情、双行资源条、双大招徽记和推送取帧都正常。

## 数字

| 项目 | 2.4.7 | 2.5.0 |
| --- | --- | --- |
| 镜像大小 | 4,055,440 B | 3,135,392 B（-920,048） |
| app 分区余量 | 73,328 B | **993,376 B** |
| Flash Data（rodata） | 2,014,840 B | 1,094,360 B |
| Flash Code（.text） | 1,896,408 B | 1,896,840 B（基本不变） |

## 做了什么

表情/特效的位图原来是用 RGB565/RGB565A8 **未压缩**存进固件的，占了大约 1.12MB。这次全部改用 LVGL 自带的 **RLE 无损压缩**：

1. 安装配置里打开 `CONFIG_LV_USE_RLE=y`（就是之前「RLE 解码失败」的真正原因——解码器根本没编进去）；
2. 用 `LVGLImage.py --compress RLE` 重新生成全部表情、特效位图；
3. 4 个日常表情把底色烘进图里（RGB565），省掉整层透明通道；
4. 图标仍由 `battle_assets.c` 提供，避免符号重复。

RLE 是无损的，所以画面和 2.4.7 逐像素一致。

## 验证

- 12 个表情 + 4 个特效（感叹号/爱心/问号/Z）逐张截图确认正常：`~/Documents/linx-hud-spike/evidence/rle_sheet.png`
- 双人两行资源条 + 左右两个大招徽记：`evidence/rle_dual.png`
- 压测：累计 525 帧表情/情绪切换（120 + 405 帧，含 pvp/solo 交替、对手资源、情绪覆盖），无重启、无 assert；`free sram` 从头到尾都是 **43,727 B**（minimal 39,715 B），没有泄漏
- 系统界面（配网/设置）仍可正常让位：`hud.sysui` 打开后黑底 + 顶栏（WiFi/时间/电量），关闭后回到待命脸
- 开机日志：`App version: 2.5.0`、`HUD created: 12 expressions`、`BattleLink: link connected`（正式环境 WS 正常）
- 设备现在跑的就是 2.5.0，处于待命/休眠脸状态

## 回滚

```bash
/tmp/linxvenv/bin/esptool --chip esp32s3 -p /dev/cu.usbmodem2101 -b 460800 \
  write-flash --flash_mode dio --flash_size 16MB --flash_freq 80m \
  0x20000 ~/Documents/linx-hud-spike/firmware/xiaozhi-hud-2.4.7.bin
```

## 归档

`~/Documents/linx-hud-spike/firmware/`：

- `xiaozhi-hud-2.5.0.bin`（sha256 前 16 位 `fe293fa18567ea86`）
- `xiaozhi-hud-2.5.0.patch`
- `assets/2.5.0/`（31 张中间 PNG）、`scripts/gen_face_assets_rle.py`（可逐字节复现 `face_assets.c`）
- `README.md` / `ARCHIVE.md` / `IMPLEMENTATION.md` 已更新

## 空间都去哪了（2.5.0，链接后）

| 库 | Flash 合计 | 其中 rodata |
| --- | ---: | ---: |
| libmain.a（含表情位图、HUD、协议） | 480 KB | 336 KB |
| LVGL | 230 KB | 38 KB |
| libdl_lib（音频/数学模型） | 224 KB | 7 KB |
| libstdc++ | 216 KB | 79 KB |
| xiaozhi-fonts（中文字模） | 207 KB | 206 KB |
| esp-opus | 182 KB | 22 KB |
| net80211 / mbedtls / wifi-connect / lwip | 90–131 KB | — |

剩下的 rodata 大头就是我们自己的表情位图（RLE 后约 200KB）和中文字模（206KB）。

## 还能继续优化的方向（这次没做）

| 手段 | 预估收益 | 风险 |
| --- | --- | --- |
| 字体子集化（`xiaozhi-fonts` 三个大字模 90/56/25KB） | 100KB+ | 高：Wi-Fi 名等运行时文本可能缺字 |
| 裁掉未用组件（`esp_emote_gfx`、`image_player` 等） | 30–60KB | 中：要改依赖和条件编译，得逐板验证 |
| 关断言 / 降日志等级 | 几十 KB | 中：联调期丢崩溃现场 |
| 资源搬到 8MB assets 分区 | 可放更多素材 | 高：要自己做分区 FS 和读取逻辑 |

以现在约 970KB 的余量，再放 10–20 张表情或几段短 BGM 都没问题，短期内不用再碰这些。

## 说明

- 分支 `feat/device-hud` 仍只在本地，未推 GitHub。
- 仓库文档补了一节「表情资源 RLE 压缩」和两条新踩坑（提交 `9fe706c`）。
