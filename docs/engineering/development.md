# 开发与运行

> 本地怎么把服务跑起来、每个脚本做什么、配置和调试入口在哪。玩法与数值见[玩法机制](../game/game-design.md)，接口与身份见 [MCP 接口](mcp-api.md)，测试矩阵见[测试与质量](../testing/testing.md)。

## 环境

- Node.js ≥ 20，包管理器 pnpm；具体版本以 `package.json` 的 `engines` 与 `packageManager` 为准。
- 不配置任何密钥也能完整跑通对局：规则、对手 AI 与播报都有本地实现，模型层缺失时自动回退。
- 需要真实模型时，从 [`.env.example`](../../.env.example) 复制出 `.env` 再填；密钥不入库、不写进日志。

## 常用脚本

| 命令 | 作用 |
| --- | --- |
| `pnpm dev` | 开发模式启动服务，默认 `0.0.0.0:8000` |
| `pnpm start` | 运行构建产物 `dist/` |
| `pnpm build` | 清理后编译 TypeScript |
| `pnpm typecheck` | 类型检查 |
| `pnpm test` | 全量单元与集成测试 |
| `pnpm coverage` | 覆盖率门槛检查（行 95% / 分支 95% / 函数 95%） |
| `pnpm validate` | v0.2 数值对拍（256,000 局） |
| `pnpm smoke` | 对本地运行中的服务做 MCP 冒烟 |
| `pnpm demo` | 脱离 MCP，直接跑一局看玩法与播报 |
| `pnpm sandbox` | 启动本地假平台与沙箱页面，默认 `0.0.0.0:8100` |
| `pnpm sandbox:say --device web-p1 "强攻"` | 以指定身份说一句，观察播报与局面 |
| `pnpm sandbox:state` / `sandbox:tools` | 查看沙箱当前视角与工具清单 |
| `pnpm sandbox:selfplay --rounds 3` | 两个假玩家自动打完指定局数 |

## 配置与数据

- 服务端环境变量见[接入灵犀平台 · 环境变量](linx-integration.md#7-环境变量)，沙箱自己的 `SANDBOX_*` 见[沙箱配置](../testing/sandbox.md#配置项)。
- 对局、房间与补账都存内存，进程重启即清空；空闲过期由 `BATTLE_TTL_SECONDS` 控制。单实例演示不需要数据库或 Redis。
- `LOG_LEVEL=debug` 会打印每条进出 MCP 的原始报文，排查平台调用时使用；生产环境不要开。

## 调试入口

服务提供 `GET /state` 快照、`GET /events` 状态流、`GET /admin` 只读监控页与 `/debug/*` 调试端点。身份头、参数与开关见 [MCP 接口 · HTTP 入口](mcp-api.md#http-入口)；调试端点由 `ENABLE_DEBUG_ENDPOINTS` 控制，生产环境关闭。

## 提交前

按改动类型选择验证，至少通过 `pnpm typecheck` 与受影响测试；规则、数值、并发与协议改动按[测试与质量](../testing/testing.md)执行对应门禁。提交规范、分支与文档同步要求见根目录 [AGENTS.md](../../AGENTS.md)。
