# AGENTS.md — 共鸣：闻声对决（linx-fighter）

给在本仓库写代码的 AI 的约束。只写本仓库特有的东西；通用规范（中文注释与 commit、不造无意义薄封装、不提及他人）见全局配置，不在这里重复。

## 项目

- **是什么**：灵犀（七牛 Xrobot 语音硬件）上的 1v1 回合制语音对战。玩家用嘴下令，服务端持有对局并结算，平台侧模型只负责理解意图、调用工具、朗读结果。服务通过 MCP 接入平台。
- **分工**：ASR、TTS、唤醒都在灵犀平台侧，本服务只接收文字、只返回文字。不要引入语音库、不要处理音频。
- **命名**：中文名「共鸣：闻声对决」（暂定）；英文名 `linx-fighter` 用于仓库名、包名、服务名、`systemd` 单元与镜像名。面向玩家的文案用中文名。如需改名，搜这几处并同步灵犀控制台的智能体名称与提示词：`README.md`、`docs/linx-integration.md`、`src/mcp/server.ts`、`src/mcp/tools.ts`、`src/game/narrator.ts`、`src/http/app.ts`、`src/index.ts`、`test/mcp.e2e.test.ts`。
- **截止**：黑客松评审 2026-10-26 09:00 现场演示，时间以小时计。优先级 **闭环能玩 > 数值平衡 > 打磨**；每个需求先问「演示必须吗」。
- **现状**：MCP 双传输、对局状态、播报已打通；命中、伤害、对手行动、胜负仍是占位，接入点集中在 `src/game/engine.ts` 的 `resolveTurn` 与 `TODO(玩法)`。
- **路线**：PVP 双人对战在规划中，服务端要预留配对与房间；演示阶段可以只做口头承诺，底层视时间再实现。
- **明确不做**（除非用户要求）：多实例/Redis/数据库、账号体系、前端页面、可观测性平台、容器编排。

## 资料

| 文档 | 用途 |
| --- | --- |
| `README.md` | 现状、命令、MCP 接口与请求头、部署 |
| `docs/architecture.md` | 分层职责与**已定决策**（改传输、存储、工具返回值前必读） |
| `docs/game-design.md` | 玩法施工图：已实现 / 待定 / 每项改哪里（改结算前必读） |
| `docs/linx-integration.md` | 平台接入步骤、智能体提示词、排障 |

`docs/xrobot-dev-spec/` 是平台官方文档的整份拷贝（含大量图片）：**只读、按需单篇读**，不要编辑，也不要整目录检索图片。常用：`mcp/software-mcp.md`（请求头、`structuredContent`）、`mcp/hardware-mcp.md`（设备侧 JSON-RPC）、`guide/agent-config.md`（智能体配置）。

## 技术栈与命令

TypeScript ESM（NodeNext：相对导入必须带 `.js` 后缀）、Node ≥ 20、pnpm、Express 5、`@modelcontextprotocol/sdk`、zod、node:test。

```bash
pnpm dev        # tsx watch，0.0.0.0:8000
pnpm test       # 单元测试 + MCP 端到端
pnpm typecheck  # 唯一的静态门禁（没有 lint）
pnpm demo       # 不连 MCP，直接看每个指令的播报
pnpm exec tsx scripts/smoke.ts http://127.0.0.1:8000   # 真实调用链自检
```

改完必须 `pnpm typecheck && pnpm test` 全绿；改玩法必须补测试。

## 分层与落点

依赖只能自上而下：`http` → `mcp` → `game` → `store`。`engine` / `narrator` 不 import MCP 或 HTTP，否则 `scripts/demo.ts` 脱离协议就跑不动。

| 要改什么 | 改哪里 |
| --- | --- |
| 招式、口语别名、ASR 误识别、唤出指令 | `src/game/types.ts` 的 `ActionId` + `src/game/actions.ts` 的 `ACTIONS` |
| 回合结算、数值、胜负 | `src/game/engine.ts` 的 `resolveTurn` |
| 播报文案 | `src/game/narrator.ts` |
| 业务流程（开局 / 出招 / 战况 / 说明） | `src/game/service.ts` |
| 工具定义与参数 | `src/mcp/tools.ts`、`src/mcp/server.ts` |
| 路由、传输、请求头 | `src/http/app.ts` |
| 存储 | `src/store/battles.ts`（对外 `get/set/delete/sweep/size` 不变） |

## 语音输入

ASR 在平台侧，错误是常态（「攻击」被识别成「公鸡」）。这层容错只能我们做。

- `matchAction` 必须容忍同音/近音（公鸡、工击 → 攻击）和句中夹杂（「我要公鸡你」）。常见误识别按招式维护在 `ACTIONS.asrErrors` 里，与口语别名区分开，新增招式时一并补误识别样例。
- 每招两条中二「唤出指令」（`ACTIONS.chants`，如「共鸣斩破军」）：整句靠包含匹配命中，命中后播报先回念一句；一个唤出词只映射一招，不能影响单字别名「打」「躲」的精确匹配。
- 可选方向（未选型）：加一层「文本 → 招式 + 置信度」的决策模型（如 JEV/LAYA 一类），让说法更自由。约束：规则匹配必须作为兜底；模型只归一化意图，不产出数值、不改对局状态；要能离线跑、低延迟；选型定了先更新本节。

## 规则

1. **服务端是唯一事实来源**：气血、真气、回合、胜负只在 `engine` 算。不要依赖平台侧模型记住或推演数值。
2. **`resolveTurn` 保持纯函数**：不改入参、返回新状态；随机数用 `battle.seed` 派生（需要时新建 `src/game/rng.ts`），不要在结算里散用 `Math.random`。
3. **播报是为「听」写的**：只在 `narrator.ts` 拼中文口语；一次最多两句、60 字内；不用 Markdown、列表、emoji、括号补充。`content[].text` 会被原样念出来。
4. **认不出就重说**：语音识别错误是常态。招式认不出时**不推进回合、不改数值**，只提示可选说法。
5. **工具不抛异常**：错误统一转成 `isError: true` + 一句玩家能听懂的话，并记 `logger.error`；协议层保持正常响应。
6. **身份只从请求头来**：`X-Linx-Device-Id` / `X-Linx-Agent-Id` / `X-Linx-Session-Id` 由平台注入，不进工具入参；对局键是 `deviceId#agentId`，不要按 session 存。
7. **两套传输都留着**：平台实测走 `POST /mcp`（Streamable HTTP），SSE（`GET /mcp` 或 `/sse` + `POST /mcp/message`）保持兼容，`DELETE /mcp` 直接 200。改路由前先看 `docs/architecture.md` 的设计决策。
8. **招式扩展不新增工具**：扩 `ActionId` 复用 `game_action`；工具总数控制在 5 个以内（平台侧模型工具越多越容易选错）。只有需要驱动设备动作才返回 `structuredContent.funcs`（`linx_play` / `linx_stop` / `change_role`），`content.text` 保持可读。
9. **数值集中**：可调参数放 `engine.ts` 顶部常量或独立数值表，不散落魔法数字；同时把取值与理由写进 `docs/game-design.md`。
10. **日志**用 `src/log.ts` 的 `createLogger` 结构化字段（`logger.info('消息', { ... })`），不要 `console.log`（`log.ts` 内部除外）。
11. **不加依赖、不扩栈**：需要新库先问；单实例内存存储够用。
12. **PVP 是新增层**：配对与房间独立于现有 1v1，不改 `Battle` 的语义；玩家身份仍是 `deviceId#agentId`，没有匹配到人时用 AI 兜底，保证演示随时能玩。

## Git 与 PR

`main` 受保护：**不要直接 commit 或 push 到 main，不要 force push**。所有改动走特性分支 + PR。

```bash
git fetch origin
git switch -c feat/<主题> origin/main
# ...改动...
pnpm typecheck && pnpm test
git add -A && git commit -m "feat(game): 接入命中与伤害结算"
git push -u origin feat/<主题>
gh pr create --fill
```

- 分支前缀 `feat/`、`fix/`、`docs/`、`refactor/`；一个 PR 只做一件事，做出可演示的改动就尽快开 PR。
- 提交信息用 Conventional Commits，正文中文，一行说清做了什么，不写流水账。
- PR 描述写「改了什么 / 怎么验证」，附验证命令与结果。
- 合并 PR 需要用户确认；演示当天的紧急修复也走分支 + PR。

## 演示环境

- 内网机 `100.100.61.41`，代码 `/opt/linx-fighter`，systemd `linx-fighter.service`；公网靠 `linx-tunnel.service`（bore），控制台填 `http://bore.pub:3216/mcp`。排障见 `docs/linx-integration.md`。
- 发布用 `scripts/deploy.sh`（编译 → rsync → 装生产依赖 → 重启 → 自检）。
- 自检：`curl http://127.0.0.1:8000/health`、`pnpm exec tsx scripts/smoke.ts <baseUrl>`。
- 演示前不要动隧道、端口、systemd 配置；不提交 `.env`、密钥、`dist/`、`node_modules/`。
