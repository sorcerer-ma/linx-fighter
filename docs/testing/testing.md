# 测试与质量

> 本文说明测试怎么跑、各文件覆盖什么，以及 CI 的门槛。玩法数值以 [玩法机制](../game/game-design.md) 为准，沙箱操作见 [沙箱说明](sandbox.md)。

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `pnpm typecheck` | TypeScript 类型检查（`tsc --noEmit`） |
| `pnpm test` | 全量单元与集成测试（Node 内置 test runner + tsx） |
| `pnpm coverage` | 覆盖率门槛：行 95%、分支 90%、函数 95%（统计 `src/**/*.ts`，排除 `src/index.ts`） |
| `pnpm validate` | v0.2 规则对拍：8 种策略 × 各参数组合 × 2000 局，共 256,000 局 |
| `pnpm build` | 清理 `dist/` 后按 `tsconfig.build.json` 编译 |
| `pnpm smoke` | 对本地运行中的服务做 MCP 冒烟（先 `pnpm dev`） |
| `pnpm sandbox:selfplay --rounds 3` | 双人沙箱整局自对弈（先 `pnpm dev` 与 `pnpm sandbox`） |

CI 在 push 到 `main` 与 PR 时依次执行 typecheck → coverage → validate → coverage:lcov → build（[`.github/workflows/ci.yml`](../../.github/workflows/ci.yml)）。覆盖率低于阈值、数值对拍出现漂移都会直接失败，不靠人工看一眼报告。

Codecov 上传使用仓库 Secret `CODECOV_TOKEN`（公开仓库 tokenless 也可用，但受保护分支会要求 token；token 在 Codecov 仓库设置里获取）；缺失或未认证时上传会报 `Token required - not valid tokenless upload` 或 `Token required because branch is protected`，`fail_ci_if_error: false` 不会阻断构建。公开仓库的徽章无需额外 badge token。

## 测试矩阵

| 范围 | 测试文件 | 覆盖重点 |
| --- | --- | --- |
| 招式与结算 | `actions.test.ts`、`engine.test.ts`、`simulation.test.ts` | 别名与唤出词、最多三招歧义、结算顺序、能量与合法性、MT19937 移植与对拍子集 |
| 语义解析 | `command.test.ts`、`asr.test.ts`、`routing.test.ts`、`router.test.ts` | 一句话读成命令、否定与问句拦截、同音纠错、三层路由顺序、模型路由解析与回退 |
| 归属与串音 | `seat.test.ts`、`crosstalk.test.ts` | 双人座位口令、回灌识别、`strict` 模式的串音降噪、命中后不推进 |
| 对局编排与并发 | `service.test.ts`、`serialize.test.ts`、`rooms.test.ts`、`store.test.ts`、`state.test.ts` | 开局/出招/换房、按对局排队与写回校验、房间索引、过期清理、局面快照 |
| 双人与载体 | `pvp.test.ts`、`echoes.test.ts` | 双人视角镜像、无屏补账、模型路由兜底 |
| 播报与事实 | `narrator.test.ts`、`presentation.test.ts`、`reply-check.test.ts` | 开局/回合/终局播报、事实与文本同源、改写检查的数值与归属校验 |
| 对手与问答 | `enemy.test.ts`、`enemy-jev.test.ts`、`chat.test.ts` | 本地决策、JEV 输入输出与超时回退、规则外问答清洗 |
| MCP 与 HTTP | `tools.test.ts`、`mcp.e2e.test.ts`、`streamable.test.ts`、`http.test.ts`、`context.test.ts`、`config.test.ts`、`provider-config.test.ts`、`log.test.ts` | 工具契约与返回、两种传输、身份与载体头、配置解析与密钥路由、日志脱敏 |
| 后台监控 | `admin.test.ts` | 只读读模型、访问控制、错误口令也计入限速 |
| 沙箱 | `sandbox.test.ts`、`sandbox-agent.test.ts`、`sandbox-companion.test.ts`、`sandbox-conversation.test.ts`、`sandbox-listening.test.ts` | 沙箱服务接口、每条原话只调一次 `game_say`、伙伴视图与大招就绪、会话列表滚动、浏览器识别会话 |

## 口径与边界

- **同源事实**：`presentation.test.ts` 要求事实直接来自结算结果，不从播报文本反解析；`reply-check.test.ts` 校验改写不能新增数字、交换归属或丢掉下一步。
- **模型替身**：命令路由、JEV 对手、规则外问答与沙箱表达模型在测试里注入假实现，不依赖真实密钥或外部网络。真实模型的输出质量只能靠本地授权联调与人工验收。
- **数值对拍**：`simulation.test.ts` 跑快速子集保证日常反馈，`pnpm validate` 用 CPython 同款 MT19937 跑全量；规则、随机顺序或伤害数值变动必须同步夹具与 [玩法机制](../game/game-design.md)，不能只改夹具消除失败。
- **HTTP 与端口**：HTTP/Streamable 测试会在本机监听端口，CI 环境需允许本地回环。
- **真机边界**：仓库测试覆盖服务端行为与沙箱链路，不等于真机唤醒、ASR、TTS 与声学环境验收；真机结果记录在 [产品验收](../product/acceptance-and-playtest.md)。
