# 黑客松答辩材料

「共鸣：闻声对决」现场答辩用的标识、幻灯片、先导片脚本与亮点清单。全部材料按同一个口径写：**只写已经跑得上、验得了的部分，没验收的明确标出来。**

演示时间：2026-10-26 09:00（Asia/Shanghai）。

## 文件

| 文件 | 用途 | 说明 |
| --- | --- | --- |
| [pitch-deck.pptx](pitch-deck.pptx) | 答辩主稿，10 页 | 每页带备注，写讲法、评审要素与出处；事实口径以备注为准 |
| [video-script.md](video-script.md) | 110 秒先导片脚本 | 9 个镜号的分镜表 + 拍摄清单 + 字幕规范，附压到 90 秒的删减方案 |
| [real-device-checklist.md](real-device-checklist.md) | 答辩前真机验收清单 | 手机页、`wait_event` 续挂、ASR 易混词的逐项判据与看日志命令 |
| [highlights.md](highlights.md) | 十条亮点与证据 | 每条给证据路径、统计口径和边界；末尾列「还没实现的」和「不能说的话」 |
| [logo.svg](logo.svg) | 主标（标记 + 字标横排） | 文字已转曲，不依赖本机字体；纸色底上用 |
| [logo-mono.svg](logo-mono.svg) | 单色版 | 用 `currentColor`，放到深色底时改外层 `color` |
| [logo-mark.svg](logo-mark.svg) | 方形标记 512×512 | 头像、角标、设备贴纸 |
| [logo-mark-mono.svg](logo-mark-mono.svg) | 方形标记单色版 | 同上 |
| [logo-1024.png](logo-1024.png) / [logo-512.png](logo-512.png) | 方形标记位图 | 透明底，注册与平台上传用 |
| [logo-lockup-1024.png](logo-lockup-1024.png) | 横排主标位图 | 透明底，用于非 SVG 环境 |
| [screenshots/mobile-dock-375.jpg](screenshots/mobile-dock-375.jpg) | 手机页 375×667 实测 | 第 3 页右侧配图；底栏与键盘入口常驻 |
| [screenshots/mobile-dock-before-after-375.jpg](screenshots/mobile-dock-before-after-375.jpg) | 手机页改前/改后对比 | 375×667 同屏对照，供真机验收说明 |

## 答辩怎么走

1. **开场 0:00–0:40 用第 1–2 页**：一句话说清「玩家用嘴指挥硬件伙伴，和朋友面对面打一场」，再讲三个停住的地方（语音助手停在问答、硬件伙伴停在卖萌、派对游戏停在屏幕）。
2. **0:40–2:40 用第 3 页配现场演示**：开房、加入、出招、应对，四句话放的是**直接朗读的原话**，可以照着念。设备掉线就念这一页当兜底。
3. **2:40–4:00 用第 4–5 页**：先讲规则引擎统一裁决，再讲四层架构与三条硬边界（模型不产生数值、客户端不推演、随机可复现）。
4. **4:00–5:30 用第 6–7 页**：这是答辩核心——平台没给的能力逐条换路补回来；再回答「为什么必须是语音和硬件」。
5. **5:30–7:00 用第 8–9 页**：先讲能跑的数字，主动讲还不能吹的部分，再说演示周、之后两周、三个月分别做什么。
6. **收尾用第 10 页**：三个角色分工、三条 Ask、收尾句。

先导片建议放在第 2 页之后播一次，或者在展位循环。拍摄与剪辑要求见 [video-script.md](video-script.md)。

## 演示兜底

现场优先真机。平台断连、设备没电或场地网络不通时，按第 3 页的四句原话念一遍——这一页本来就是可直接朗读的台词；要证明服务端闭环还在，就当场跑自对弈：

```bash
# 终端 1：沙箱页（默认 8100；被占用时换 SANDBOX_PORT）
pnpm sandbox
# 终端 2：两个沙箱身份打三局，校验双方视角镜像
pnpm sandbox:selfplay --rounds 3
```

前提是游戏服务在本机 `8000` 端口。2026-10-25 本地实测 3 局全部通过，每局 3 轮结束，镜像校验每局 7–8 次通过。自对弈只证明规则与状态同步，不替代语音和硬件演示，讲的时候要说清楚。

## 事实基线

材料里的规则数值、识别命中率、对拍局数均来自仓库，改写前先核对来源：

| 内容 | 出处 |
| --- | --- |
| 招式、能量、生命值、先手补偿、按轮加压 | [玩法机制](../game/game-design.md)、`src/game/rules.ts` |
| 256,000 局对拍、3–5 轮结束占比 | `pnpm validate`、`test/fixtures/v02-validation.json`、[定位与范围](../product/positioning-and-scope.md) |
| 64 条语料、92.2% 混合路由命中 | [命令路由评测](../engineering/command-routing.md) |
| 平台能力取证（无热词、无音频旁路、无说话人） | [平台语音能力](../engineering/platform-voice-capabilities.md) |
| 播报措辞、补账 | [语音与反馈](../product/voice-and-feedback.md)、`src/game/narrator.ts` |
| 玩家旅程原话 | [玩家旅程](../product/player-journey.md) |
| 演示形态与时间 | [定位与范围](../product/positioning-and-scope.md) |

两处要特别说明，别念串：

- **手机网页伙伴页**在 `feat/sandbox-mobile-companion` 分支，尚未并入主干、未经验收。第 3 页右侧已换成 375×667 的本地 Chromium 实测截图（底栏常驻、键盘入口可见），真机验收后再换成真机画面。
- **`wait_event`（第六个工具）**同样在特性分支，真实链路上触发不稳定。材料里写「已实现、真机待修」，不写「已上线」。

## 改材料

- **改 deck**：直接改 `pitch-deck.pptx` 也行；要批量改文案与版式，用 python-pptx 生成后再渲染检查。本仓库不保存生成脚本，改完按下面的方法自查。
- **改 logo**：`logo.svg` 与 `logo-mark.svg` 是手写的路径，改色改弧线都在文件里直接调；字标已转曲，换字要找同一款字重重新排版转曲。
- **导出 PNG**：SVG 转位图用 Chrome 无头渲染，透明底要显式指定：

  ```bash
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    --headless=new --disable-gpu --hide-scrollbars \
    --default-background-color=00000000 \
    --window-size=1024,1024 \
    --screenshot=logo-1024.png file:///绝对路径/page.html
  ```

  页面里用 `<img src="logo-mark.svg" width="1024">` 包一层即可，直接把 SVG 当页面打开会带上浏览器默认底色。

## 检查记录

- 幻灯片按 13.333×7.5 英寸制作，用 LibreOffice 原生后端渲染成 1920×1081 的 PNG 逐页目检，共 10 页，无缺字体（PingFang SC 已在本机命中）。
- 逐页修过的问题：文本框样式带来的主题阴影；第 2 页手动换行造成的孤字；第 3 页列宽导致的断行；第 8 页数字网格溢出；第 9、10 页条目间距与对齐。第 3 页右侧已补 375×667 实测截图并重新渲染，当前 10 页均无溢出与重叠。
- 投影前建议在答辩机再打开一次，确认装有 PingFang SC；没有的话用系统里任一中文字体替换，字号不要放大（标题 40pt、正文 11–13.5pt 是按版心调过的）。

## 还需要人工补的

- [ ] 手机页与 `wait_event` 续挂按 [real-device-checklist.md](real-device-checklist.md) 走一遍，记录设备、时间与日志。
- [ ] 第 3 页右侧：本地 Chromium 截图已补，真机验收后替换成真机画面。
- [ ] 先导片成片：按 [video-script.md](video-script.md) 拍完剪完，替换展位循环素材。
- [ ] 第 10 页团队页：如评委需要实名，补姓名与背景；当前只写角色分工。
- [ ] 真机验收后的数字更新：唤醒、朗读、设备侧动作通过后，把第 8 页「还不能吹的」相应条目改掉。
