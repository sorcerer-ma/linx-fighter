# 十条亮点（带证据与口径）

对外材料、答辩提问、PR 描述都可以从这里取。每条都写明**证据在哪**、**数字怎么来的**、**不能往大里说的地方**。

引用原则：能给文件路径就给路径；仓库里没有记录的实测，一律不写进对外材料。

---

## 01 语音是唯一入口，不是可选输入

玩家的每一句话走同一个入口：`/api/say` → MCP `game_say`，平台把原话原样透传，服务端负责判断这句话是出招、应对、查询、开局、开房还是别的。没有触控作弊通道，沙箱页面的按钮也只能把说法填进输入框。

- 证据：`src/mcp/tools.ts`、`src/game/command.ts`、`docs/product/product-design.md`
- 口径：沙箱页面与真机都只有一条输入路径，页面只读同步局面
- 边界：语音识别本身由平台完成，我们拿到的是文本；识别质量不是我们能直接控制的

## 02 规则引擎统一裁决，模型改不了数值

生命值、能量、轮次、暴击、闪避、胜负全部由 `resolveTurn` 这类纯函数算出：输入不变、输出不变。模型只在三处出现——命令路由、对手决策、规则外问答，且都只能在既定选项里挑。

- 证据：`src/game/rules.ts`、`src/game/engine.ts`、`src/game/router.ts`、`src/game/enemy-jev.ts`、`src/game/chat.ts`
- 口径：路由与对手决策的返回值都要再过一遍合法性校验；失败回退到本地规则或固定话术
- 边界：接上外部模型后，不能承诺「仅凭 seed 重现整局」；可复现的前提是同一份随机输入与同一套策略

## 03 256,000 局对拍，零漂移

`pnpm validate` 用 8 种策略 × 16 种对阵组合 × 每组合 2000 局，跑 256,000 局，与 `test/fixtures/v02-validation.json` 逐项比对；MT19937 按参考实现精确移植，随机序列一致。

- 证据：`test/fixtures/v02-validation.json`、`test/helpers/mt19937.ts`、`test/simulation.test.ts`、`scripts/validate-v02.ts`
- 复现：`pnpm validate`（本地约数十秒）
- 边界：数字来自本机与 CI 的确定性脚本，不是「在线对战 256,000 局」

## 04 三层识别：先查表，再问模型

一句话先过规则（`readCommand`，零延迟），再过端侧同音字表（58 个音节、1700 余字的离线词典，毫秒级），最后才交给命令路由模型；模型只判「这句话属于哪一类」，不做数值。

- 证据：`src/game/command.ts`、`src/game/asr.ts`、`src/game/router.ts`、`docs/engineering/command-routing.md`
- 口径：64 条自拟语料的四方案对比里，混合方案命中 92.2%，p50 0.24ms，p95 0.85s，仅 8 次模型调用；纯模型 90.6%，p50 794ms
- 边界：语料是自拟的、只有 64 条，不能当成平台真实语料的准确率；模型版本变化会影响结果

## 05 平台没给的能力，逐条有替代方案

对照 46 页平台文档确认：ASR 没有热词/词表，音频只以 JSON 透传、没有旁路，MCP 只给三个 `X-Linx-*` 头、拿不到「谁在说话」。对应做法写在同一份文档里：端侧同音补热词、服务端只吃文本、按 `deviceId#agentId` 认人。

- 证据：`docs/engineering/platform-voice-capabilities.md`
- 口径：文档里每个「没有」都标了出处章节；结论 5.5 评估过自建 WS + ASR 约需 9 人日（乐观 6），因此演示前不做
- 边界：这是「当前文档版本」的结论，平台更新后要重新核对

## 06 无屏也能补账，有屏不打扰

一方出手后，另一方在自己的回合结算。无屏玩家下次开口时，伙伴先补上一手的结果再说当前回合；有屏玩家（`X-Linx-Display: screen`）能自己看面板，就不念补账。

- 证据：`src/game/narrator.ts`、`src/store/echoes.ts`、`src/mcp/context.ts`
- 口径：补账只补一次；换房、换局时清理；补账后会重新核对总长度
- 边界：补账只在双人行动与状态查询路径取走，不是「任何发言都补账」

## 07 双人房间有归属、有并发保护

对局的读改写走 `BattleTransactions`，钥匙是存储键；写回前确认还是同一局、同一座位，对不上就丢弃并请玩家重说。换房时先加入目标房再清理旧房，加入失败保留原局。

- 证据：`src/game/serialize.ts`、`src/game/service.ts`、`src/game/pvp.ts`、`src/store/rooms.ts`
- 口径：模型路由回来的这一手带着开始思考时的对局 id，进事务后要重新核对
- 边界：单机内存存储，没有 Redis/数据库/多实例

## 08 播报是可朗读的短句，不是模板拼接

伙伴用第一人称「我」自述，称玩家「你」、称对方「对手」；常规播报按两句、60 字控制，不带 Markdown 和表情。识别失败和闪避失败分开说，不提前宣布命中。

- 证据：`src/game/narrator.ts`、`docs/product/voice-and-feedback.md`
- 口径：测试里有长度断言；补账与唤出词拼接后也检查总长度
- 边界：真机 TTS 的语速、停顿尚未验收

## 09 没有真机也能把链路跑通：沙箱 + 自对弈

沙箱自己扮演灵犀平台：页面收原话 → `game_say` → 服务端裁决 → 页面朗读，局面走 SSE 只读同步。两个脚本可以互相对打，并校验双方视角是否镜像。

- 证据：`sandbox/`、`docs/testing/sandbox.md`
- 复现：`pnpm dev` + `pnpm sandbox`；`pnpm sandbox:selfplay --rounds 3`
- 边界：沙箱通过不等于真机通过；麦克风在手机上需要 HTTPS

## 10 工程门禁挡住回退，不靠人盯

类型检查、测试、覆盖率阈值（行 95 / 分支 90 / 函数 95）、数值对拍、构建、冒烟都在 `package.json` 与 CI 里；改动结算逻辑必须同时过测试和对拍。

- 证据：`package.json`、`.github/workflows/ci.yml`、`tsconfig.json`
- 口径：覆盖率是门槛不是目标；对拍失败必须解释原因，不能直接更新夹具
- 边界：唯一的静态门禁是 `typecheck`，没有 lint；HTTP 测试需要本机端口

---

## 还没实现的（别写进「已完成」）

| 项 | 现状 | 位置 |
| --- | --- | --- |
| `wait_event` 挂起等对手 | 特性分支实现，真机链路触发不稳 | `feat/hw-wait`：`src/mcp/tools.ts:186`、`src/game/service.ts:271` |
| 手机伙伴页 | 特性分支实现（+1492/−465），未合入主干、未验收 | `feat/sandbox-mobile-companion` |
| 真机唤醒 / ASR / TTS | 未验收，仓库里没有真机数据 | `docs/product/acceptance-and-playtest.md` |
| 设备侧动作（`structuredContent.funcs`） | 未验证 | `docs/product/positioning-and-scope.md` |

## 不能说的话

- 「语音识别准确率 92%」——那是命令归属的命中率，不是 ASR 的字准率；
- 「已支持多人」——现在是 1v1 双人房，没有匹配、没有多实例；
- 「真机验证通过」——真机只做了探索性联调，验收清单还没走完；
- 「随机结果绝对可复现」——外部模型接入后只保证规则侧的确定性。
