# 设计参考：读招、资源与节奏

> 这份文档不是玩法规格，而是「同样的设计问题，别人怎么解」的对照笔记。
> 改招式、改补偿、改节奏之前先看这里，避免把已经踩过的坑再踩一遍。
> 事实与出处见文末链接；对局内的数字口径一律来自 `test/fixtures/v02-validation.json`。同类产品、变现方式与竞争格局见[竞品调研](../business/competitive-analysis.md)。

## 一句话结论

我们这套东西在设计语言里是四件事的组合：**单边读招**（出招方盲、应对方明）、**资源循环**（能量）、
**递增压力**（第 3 轮起伤害 +2）、**先手补偿**（14 / 18点生命值）。这四件事在成熟游戏里都有更精确的解，
真正值得抄的不是招式表，而是**信息怎么给**——语音只有一条通道，信息给错了，深度就没了。

## 我们现在的模式，用术语说清楚

| 我们的机制 | 设计术语 | 现状判断 |
| --- | --- | --- |
| 主动出招 → 对方应对 | 单边信息不对称 | 应对方**完全知情**，最优应对可算，应对退化成查表 |
| 能量：每回合回 2、上限 5、蓄力 +1 | 资源循环 | 健康，与「读招」耦合在「能不能开大」上 |
| 第 3 轮起每轮 +2 | 递增压力 / 防拖延 | 与 Hearthstone 疲劳同族，但挂在**轮数**而非资源耗尽 |
| 先手 14点生命值 / 后手 18点生命值 | 先手补偿 | 补偿过头，见下文实测 |
| 语音单通道、无手速 | 窄信息通道 | 决定了我们不能走「操作深度」，只能走「信息深度」 |

## 七个案例

### 1. Yomi（Sirlin Games，2011）—— 猜拳为什么不浅

把格斗游戏的读招做成卡牌：攻击 / 投技 / 格挡 / 闪避四元循环，双方**同时**暗牌出招。

Sirlin 在[设计手记](https://www.sirlin.net/articles/designing-yomi)里给了三条可执行的结论：

1. **石头剪刀布本身不浅，浅的是「没有信息可依」的猜拳**。竞技游戏里到处是石头剪刀布（星际的兵种、光环的枪/雷/近战、格斗的攻击/格挡/投技），差别在于有多少信息能支撑判断。
2. **双盲承诺是对抗「被解」的手段**。「完全信息 + 无随机」的游戏会一路退化到背谱，直到被彻底解开；双盲、隐藏信息、随机是防止这件事的工具。
3. **基础类型别超过 3～4 个**。要查表才知道谁克谁，策略反而变少；深度应该来自**收益不等且难算**（risk management、valuation），而不是招式数量。

> 对我们的意义：我们的应对只有 3 个、主动 4 个，数量是对的，**不加新招式才是正确方向**。
> 但也正因如此，深度必须从「信息」和「收益不确定性」里长出来——现在的出招是完全公开的，
> 相当于把 Yomi 的双盲拆成了「我说你听」，读招只剩「他敢不敢闪避」这一层。

### 2. Marvel Snap（Second Dinner，2022）—— 同时出牌把回合长度变成常数

[Game Developer 的拆解](https://www.gamedeveloper.com/game-platforms/designers-don-t-sleep-on-marvel-snap-s-simultaneous-turns)：
六轮封顶，每轮双方同时放牌、同时翻面，单轮最多 35～40 秒，所以**整局时长有硬上限**（3～4 分钟）。
对照 Hearthstone 的 75 秒/回合 × 平均 9 轮，最坏能拖到 22 分半——回合长度取决于**最慢的那个玩家**，
这在语音场景里更严重：一次交互要过 ASR → 意图 → 结算。

> 对我们的意义：(a) 双人局没有「同时决策」，后手等待无上限，是目前最大的体验风险；
> (b) 同时决策天然消掉先后手信息差——Snap 从不需要「先手补偿」，因为双方承诺时都不知道对方选了什么。

### 3. Frozen Synapse / Atlas Reactor —— 同时规划、一起结算

Frozen Synapse 是两人同时布置指令、全部提交后[统一结算](https://en.wikipedia.org/wiki/Frozen_Synapse)，
结算是确定性的，谁先按下提交键毫无意义。Atlas Reactor 把同一套结构用在 4v4 战术回合制上
（Wikipedia 的原话是 "fast, exciting and simultaneous PvP action"）。

> 对我们的意义：如果将来做多人或队伍局，"先手"这个变量可以直接从设计里删掉，改用同时决策。

### 4. Slay the Spire / Into the Breach —— 完美信息为什么反而更深

[这篇分析](https://jeremiahgames.com/2019/03/04/perfect-information-the-killer-feature-of-slay-the-spire-and-into-the-breach/)
说得最清楚：两款年度级回合制都把敌人的下一步**明牌**（intent），带来的不是变简单，而是

- 每个回合变成一道**可解的小题**（看到 18 点攻击 → 这回合该防）；
- 失败**不能甩锅给黑箱**（"我没猜对" → "我的策略不够好"），玩家愿意为结果负责，才会往深里玩。

> 对我们的意义：我们已经对玩家明牌（`对手强攻还没结算，我该格挡、闪避，还是承受？`），这一半是对的。
> 缺的是另一半——**玩家的选项和资源没有被复述**。无屏语音里玩家记不住「3 点上限定 5、还差 1 点能开大」，
> 明牌就白明了。这是零成本的改动，见下文建议 1。

### 5. Hearthstone 的 The Coin、万智牌的第一回合、围棋的贴目 —— 先手补偿的三种形态

- **给资源**：Hearthstone 后手多抽一张 + The Coin（一次性 1 费）。[暴雪自己给的数据](https://arstechnica.com/gaming/2014/08/do-you-want-to-go-first-balancing-hearthstone-and-other-turn-based-games/)：
  全水平段先手胜率 52.2%，大师段 50.4%；BlizzCon 上又公布铜银段 +6%、大师段 +2.6%；Ars 自己统计 219 场职业赛，先手 50.23%——**基本拉平**。
- **改规则**：万智牌上线时先手胜率约 60%，改法是**先手第一回合不抽牌**；改完的 2003 年两个大赛里，
  掷骰赢的人只有 47% / 53% 赢下比赛，设计师 Buehler 的原话是 "winning the die roll was a bad thing"——补偿过了头，就轮到先手吃亏。
- **给终局分数**：围棋[贴目](https://en.wikipedia.org/wiki/Komi_(go))先手优势公认 5～7 点，标准 6.5；
  历史上从 2.5 → 4.5 → 5.5 → 6.5 **一路试出来的**，让子棋则只贴 0.5。

> 对我们的意义：先手补偿天生是**一个可调的单一旋钮**，不是拍脑袋的数字。
> 我们已经有 256,000 局对拍的基建，只是没把这个旋钮接上去（见下文建议 4）。

### 6. Hearthstone 的疲劳 —— 递增伤害为什么比「摸不到牌就输」好

最初规则是牌库空了直接判负（万智牌、游戏王同款）。[Jeff Kaplan 的一次试玩](https://www.pcgamer.com/hearthstone-got-its-fatigue-mechanic-thanks-to-jeff-kaplan/)
暴露了问题：快赢了却因为牌库空了输掉，**整局的操作都变得没有意义**。改成「每摸一次空牌堆递增伤害」后，
长局重新有了策略（控制卡组会故意少抽牌来拖疲劳），而且伤害**从第几张开始是确定的**，玩家能算。

> 对我们的意义：我们的「第 3 轮起每轮 +2」是同族做法的更简版本，公式化、可预期，方向对。
> 可借鉴的是「把递增挂到资源耗竭上」而不是纯轮数——比如能量上限随轮数下降，比单纯加伤害更有决策。

### 7. Gwent —— 用「过」替代 mana

[Gwent 的拆解](https://www.gamedeveloper.com/design/gwent-braving-the-storm)：没有法力值，
**手牌本身就是唯一有限资源**；三局两胜，每局双方轮流出一张牌，直到都选择「过」（pass）。
输掉一局的压力、要不要把牌烧在第二局逼对手跟（bleed out）、留几张进决胜局，构成了全部深度。
文章把它定位成「Hearthstone（太随机）与 Prismata（太可算）之间的中间态」——顺带给了个反面教材：
**完全信息 + 零随机**的 Prismata 会把玩家压进"必须精确计算"的死角。

> 对我们的意义：(a) 「过」是语音最友好的决策，一个字，不需要招式表；
> (b) 别为了"平衡"把暴击/闪避删掉——那不是补丁，是防被解的防线；
> (c) 反过来，也不要再往"完全可算"的方向加确定性规则。

## 我们自己的数据说了什么

从 `test/fixtures/v02-validation.json` 直接读出来的（256,000 局，8 种脚本策略互打）：

| 指标 | 数值 | 解读 |
| --- | --- | --- |
| 同策略镜像的先手胜率 | **45.0%（save=False）/ 45.7%（save=True）** | 先手在吃亏，不是占便宜 |
| 全组合先手胜率 | 47.4% / 47.9% | 同上，后手优势 2～5 个点 |
| 平均结束轮数 | 4.3 轮（p95 = 6 轮） | 局够短，节奏没问题 |
| 第 1 轮应对分布 | 闪避 58% / 格挡 26% / 硬抗 16% | 应对明显偏向同一个答案 |

两条结论：

1. **先手补偿是过度补偿**。14 / 18点生命值是 28% 的差距，再加上「应对方完全知情」，后手拿了两份优势。
   如果目标是 50/50，这个旋钮现在是往反方向拧的。
2. **应对确实退化了**。脚本策略是确定性函数——它们「看牌出应对」，第 1 轮就 58% 走闪避。
   人类当然不会这么极端，但这说明**回应侧存在一个可算的最优解**，博弈只剩在出招者那一侧。

## 建议（按成本排序）

| # | 建议 | 改哪里 | 成本 | 演示前 |
| --- | --- | --- | --- | --- |
| 1 | 应对阶段播报补一句「你现在 3点能量，可格挡 / 闪避 / 硬抗」 | `src/game/narrator.ts` | 低 | 可以 |
| 2 | 双人局应对超时（如 30 秒）视为硬抗，不再无限等 | `src/game/pvp.ts`、`src/store/rooms.ts` | 低 | 可以 |
| 3 | **隐招**：出招只播报「已出招，消耗 2点能量」，应对结算后再揭示招式 | `narrator.ts` + `state.ts` 加开关 | 中 | 不建议 |
| 4 | 把先手补偿接成可扫参数，目标是镜像先手胜率 0.50 | `src/game/rules.ts` + `scripts/validate-v02.ts` 输出 first_win | 中 | 不建议 |
| 5 | 不加招式，改加横向杠杆（大招次数、蓄力上限、能量上限随轮数变化） | `rules.ts` | 低 | 不建议 |

建议 3 是唯一能真正把「读招」做出来的改动：Yomi、Snap、Frozen Synapse 的共同点就是**双方承诺时都不知道对方选了什么**。
我们的特例是语音——不能暗牌，但可以**不说招式名**，用「消耗了几点能量」当线索，让后手去读（3 点满能量 = 可能大招）。
代价是新手不知道自己在被打什么，所以只适合做开关，并用 `pnpm validate` 的镜像先手胜率 + 应对分布做 A/B。

## 延伸资料

| 资料 | 为什么值得看 |
| --- | --- |
| Sirlin,[Designing Yomi](https://www.sirlin.net/articles/designing-yomi) | 双盲、收益不等、类型数量上限——本文档的理论骨架 |
| Sirlin,《Playing to Win》 | 「yomi layer」的原始论述：压制 / 反压制 / 反反压制 |
| Ars Technica,[Do you want to go first?](https://arstechnica.com/gaming/2014/08/do-you-want-to-go-first-balancing-hearthstone-and-other-turn-based-games/) | 先手优势的跨游戏数据（HS / MTG / 国际象棋 / 围棋）与补偿史 |
| Game Developer,[Marvel Snap's simultaneous turns](https://www.gamedeveloper.com/game-platforms/designers-don-t-sleep-on-marvel-snap-s-simultaneous-turns) | 同时决策如何同时解决时长与公平 |
| Jeremiah Franczyk,[Perfect Information](https://jeremiahgames.com/2019/03/04/perfect-information-the-killer-feature-of-slay-the-spire-and-into-the-breach/) | 为什么明牌让游戏更深而不是更浅 |
| Game Developer,[Gwent: Braving the Storm](https://www.gamedeveloper.com/design/gwent-braving-the-storm) | 资源只有手牌时的取舍；随机与可算之间的甜点 |
| PC Gamer,[Hearthstone 疲劳机制的由来](https://www.pcgamer.com/hearthstone-got-its-fatigue-mechanic-thanks-to-jeff-kaplan/) | 递增伤害是为了让整局有意义 |
| Wikipedia,[Komi (go)](https://en.wikipedia.org/wiki/Komi_(go)) | 补偿值怎么一路试出来（2.5 → 6.5） |
| Wikipedia,[Frozen Synapse](https://en.wikipedia.org/wiki/Frozen_Synapse) | 同时提交、确定结算的最小实现 |
| Amazon,[Alexa for Gaming Guide](https://m.media-amazon.com/images/G/01/mobile-apps/dex/alexa/alexa-skills-kit/guide/AlexaforGamingGuide.pdf) | 纯语音游戏的回合、复述与容错原则（还没精读，待补充） |
