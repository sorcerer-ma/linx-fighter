# 接入灵犀平台

按下面五步把服务接到灵犀设备上。前两步是部署与自检，后三步在灵犀控制台配置。

## 1. 部署

服务跑在独立服务器上，systemd 托管，nginx 在 80 端口做反向代理：

| 项 | 值 |
| --- | --- |
| 控制台填写的 SSE 地址 | `http://111.62.156.213/mcp` |
| SSH | `ssh linx-fighter-las`（`111.62.156.213:10653`，私钥登录） |
| 应用服务 | `linx-fighter.service`，代码 `/opt/linx-fighter`，用户 `linx`，监听 `127.0.0.1:8000` |
| 反向代理 | `nginx.service`，`/etc/nginx/conf.d/linx-fighter.conf`，80 → `127.0.0.1:8000` |
| 运行配置 | `/etc/linx-fighter.env`（端口、`BATTLE_TTL_SECONDS`、`API_KEY`、`ADMIN_TOKEN` 等），不进仓库 |
| 监控页 | `http://111.62.156.213/admin`（只读看板，3 秒轮询；`ADMIN_TOKEN` 为空即公开） |

常用操作：

```bash
systemctl status linx-fighter     # 应用状态
systemctl restart linx-fighter    # 重启应用
journalctl -u linx-fighter -f     # 应用日志（单行 JSON，能看到平台来的连接与出招）

curl -s http://127.0.0.1:8000/admin/api/rooms | head -c 400   # 看板数据（无 token 时）

systemctl status nginx            # 反代状态
nginx -t && systemctl reload nginx  # 改了反代配置后
```

反代必须为 SSE 与 Streamable HTTP 关闭缓冲、放宽超时，否则平台收不到 `endpoint` 事件，表现为「工具调用超时 / 连不上」。完整配置见 [`deploy/nginx-linx-fighter.conf`](../../deploy/nginx-linx-fighter.conf)，关键几行：

```nginx
proxy_http_version 1.1;
proxy_set_header Connection "";
proxy_buffering off;
proxy_cache off;
proxy_read_timeout 3600s;
```

发布新版本（在开发机仓库根目录执行，一条命令完成编译、同步、装依赖、重启，并分别自检直连与反代）：

```bash
scripts/deploy.sh
```

脚本默认发到 `root@linx-fighter-las:/opt/linx-fighter`，换机器时传参：`scripts/deploy.sh root@<主机> /opt/linx-fighter`。

机器上的 systemd 单元、环境变量样例与 nginx 配置在 `deploy/` 里有副本；改过机器上的配置后要同步回仓库：

```bash
cp deploy/linx-fighter.service /etc/systemd/system/ && systemctl daemon-reload
cp deploy/linx-fighter.env.example /etc/linx-fighter.env && chmod 600 /etc/linx-fighter.env
cp deploy/nginx-linx-fighter.conf /etc/nginx/conf.d/ && nginx -t && systemctl reload nginx
```

部署到其他机器时也可以用 Docker：

```bash
docker build -t linx-fighter .
docker run -d --name linx-fighter -p 8000:8000 -e LOG_LEVEL=info linx-fighter
curl http://127.0.0.1:8000/health
```

> 平台文档中的示例地址是 `http://...:8000/sse`，说明允许明文 HTTP。有域名和证书时可以在这台机器上换成 HTTPS。

### 1.1 模型层的出口与换网关

命令路由、对手决策和规则外问答都走同一个模型客户端（`src/game/llm.ts`），根地址、两条路径、模型名和推理开关都能用环境变量覆盖，默认指向 `https://api.modelink.ai/v1`。

开发机实测过两个兼容网关（同一 key、同一报文）：

| 目标 | 决策接口 | 语言模型 |
| --- | --- | --- |
| `api.qnaigc.com` | 1/3 成功，4.8–6.6 s；另外两次 502 busy | 2.1–3.3 s |
| `api.modelink.ai` | 4/4 成功，0.7–1.1 s | 2.9–3.0 s |

语音场景 3 秒以上等于没有反应，所以默认指向 modelink。qnaigc 的 decisions 通道在测试时段不稳定，保留为可切换的备用出口；两个网关的决策路径都是 `/systemone`、语言模型路径都是 `/chat/completions`。

运行配置（`/etc/linx-fighter.env`）：

```bash
BASE_URL=https://api.modelink.ai/v1
API_KEY=...
DECISION_PATH=/systemone
CHAT_PATH=/chat/completions
DECISION_MODEL=typesafe/jev-1.14
CHAT_MODEL=deepseek/deepseek-v4-flash
CHAT_REASONING=off
```

换别的 OpenAI 兼容网关时改 `BASE_URL` 与两条路径；密钥只放运行环境，不进仓库。推理模型要 `CHAT_REASONING=off`（发 `thinking:{"type":"disabled"}`），否则 token 可能全花在思考上、正文为空。

另外这台机器没有可用的 IPv6 出网，Node 默认会先试 IPv6，表现为请求在连接阶段快速失败（`fetch failed` / `ETIMEDOUT`，约 0.5 s）。`NODE_OPTIONS` 里的 `--dns-result-order=ipv4first` 不生效，必须写进 systemd 的命令行，并关掉 happy-eyeballs：

```ini
# /etc/systemd/system/linx-fighter.service.d/ipv4.conf
[Service]
ExecStart=
ExecStart=/usr/local/bin/node --dns-result-order=ipv4first --no-network-family-autoselection /opt/linx-fighter/dist/index.js
```

## 2. 自检

在开发机或任意能上网的机器上执行：

```bash
# 健康检查
curl http://111.62.156.213/health
# 应看到 event: endpoint 和 /mcp/message?sessionId=... 两行
curl -N -H 'Accept: text/event-stream' --max-time 2 http://111.62.156.213/mcp
# 完整协议链路（initialize → tools/list → tools/call）
pnpm exec tsx scripts/smoke.ts http://111.62.156.213
```

`smoke.ts` 会把开局、出招、战况的播报文本打印出来；文本正常说明服务端没问题，剩下的是平台侧配置。排查网络时也可以从本机穿透检查机器自己的 8000 端口：`ssh -L 18000:127.0.0.1:8000 linx-fighter-las` 后 `curl http://127.0.0.1:18000/health`。

## 3. 控制台：配置自定义 MCP

在灵犀控制台新建「自定义 MCP」，只需要填地址：

| 配置项 | 值 |
| --- | --- |
| 服务名称 | 灵犀对决 |
| SSE 地址 | `http://111.62.156.213/mcp` |
| 描述 | 语音回合制对战游戏 |

- 设备、智能体、会话三个 `X-Linx-*` 请求头由平台**自动注入**，控制台不用填（服务端在 `src/mcp/context.ts` 读取）。
- 地址填到 `/mcp` 即可。服务端同时支持两种传输：平台若走 Streamable HTTP 会直接 `POST /mcp`（实测就是这样），若走老式 SSE 会先 `GET /mcp` 再由 `endpoint` 事件下发 POST 地址，控制台不用区分。
- 配好后控制台通常有「测试/校验」按钮，能看到 5 个工具（`game_say`、`game_start`、`game_action`、`game_status`、`game_help`）即说明连通。推荐只把 `game_say` 当主入口。

## 4. 控制台：配置智能体

1. 意图识别 / 对话模型：必须选**支持 Function Call（工具调用）**的模型，否则模型不会调工具，只会自己编。
2. 勾选上一步创建的 MCP，让工具进入模型的可用工具列表。
3. 填写提示词（见下节），保存后**重启设备或重开体验页**才生效。

## 5. 两台设备靠很近：把指令算到对的机器上

真机现象：两台设备同处一屋、还共用一个智能体，B 说的话会被 A 的机器收走并替 A 出招；A 机器自己念的播报也会被自己的麦克风再收一遍，听上去像在自问自答。

服务端已经做掉的（代码里，不用配）：

1. **播报回灌判定**：`src/game/crosstalk.ts` 认得出伙伴自己的播报句式（结算数字、回合提示、房间播报、结局宣告等），命中后只回一个「嗯。」，同一局 2 秒内不再开口，不推进对局、不扣资源。玩家正常提问、否定、口号令不受影响。
2. **座位口令（可选）**：`ATTRIBUTION_MODE=strict` 后，双人房说话带上「红方 / 蓝方」（房主=红方、加入者=蓝方）就能标明是替谁说，带对方口令的直接静默、零变化；不带口令的话照旧按轮次仲裁。口令只是可选的归属标签，没有「二次确认」环节：命令路由只接受置信度 ≥ 0.6 的判定，低于阈值按没听出来处理。默认 `off`：口令一开就要玩家先习惯，没商量好反而更乱。
3. **座位引导语**：strict 模式下本机会说「红方这边，我在听，说招式就行。」，让玩家知道自己这台认哪一边。

服务端做不到、必须靠平台侧的：

- 说话人身份要「先要」才「再给」：MCP 请求头里只有 Device / Agent / Session 三个 `X-Linx-*` 头，不带说话人；但**在工具的 `inputSchema` 里声明了 `speaker` 参数之后，平台会把声纹识别出的名字填进这个参数**（平台支持侧的说明；真机待验）。五个工具都声明了它，服务端只拿它记日志、写回 `DeviceContext.speakerName`，不参与招式裁决与座位归属。
- 请求头里如果也带了 `X-Linx-Speaker-Name` / `X-Linx-Speaker-Id` 会一并接住（同样只进日志），并且每个进程第一次见到某种请求头组合时会打一条 `请求身份头快照`，把平台实际下发的自定义头列出来（`authorization`、`cookie` 之类按名字打码）。确认办法：`journalctl -u linx-fighter --no-pager -o cat --since "10 min ago" | grep -E '工具调用|请求身份头快照'`，看 `speaker` 字段有没有值。
- 平台的声纹开关（控制台「声纹功能：只回应指定的人」）是**内部门禁**：命中就转发、不命中设备直接不吭声。它要求**每台设备绑各自的智能体**，否则两台设备在平台眼里是同一个主人，声纹也分不开。
- 换设备所属智能体有官方接口（`PUT /v1/devices/{mac_address}/agent/{agent_id}`，原文「将设备切换到目标智能体」）：

```bash
curl -X PUT "https://<平台域名>/v1/devices/<mac_address>/agent/<agent_id>" \
  -H "Authorization: Bearer <平台 token>" -H 'Content-Type: application/json' \
  -d '{"disable_chat_history_migration": true}'
```

两个智能体都要勾同一个自定义 MCP（地址仍是 `http://111.62.156.213/mcp`）。对局键是 `deviceId#agentId`，换成两个智能体后两边各自独立成局，不需要改服务端代码。

现场推荐组合：

1. 两台设备分别绑各自的智能体，各自开启声纹「只回应指定的人」；
2. 服务端保持 `ATTRIBUTION_MODE=off`，播报本来就按两句 60 字控制；
3. 还串音就临时开 `ATTRIBUTION_MODE=strict`，让玩家先报红 / 蓝方再说招式；
4. 别在两台设备跟前同时喊话：唤醒词先到先得，平台没有「只认最近说话人」。

已知未验证：两个智能体能否同时指向同一个自建 MCP（平台文档没写），演示前用控制台的「测试」按钮各点一次确认。平台侧语音能力（热词、透传、声纹接口边界）的调研结论见 [平台语音能力](platform-voice-capabilities.md)。

## 6. 智能体提示词模板

直接粘贴到智能体的提示词里，按需微调：

```text
你是「灵犀对决」的对战主持，陪玩家打回合制对决。

【人格】
语气干脆、带一点江湖气；每次只说一两句话，适合语音朗读。

【工具】
玩家说的每一句话都调用 game_say，text 填玩家原话，一字不改。

不要在调用前自己判断这句话是出招、查战况、问玩法还是开房——那是服务端的工作。你只负责把原话递过去，再把返回的 text 念出来。

只有当 game_say 返回 isError、或你明确知道它在处理某个操作上失败了，才考虑用兜底工具：
- game_start：确知要重开一局、或用 pvp / room / opponent 指定明确参数时。
- game_action：确知要直接指定某一招时。
- game_status：确知要查战况、而 game_say 不可用时。
- game_help：确知要玩法说明、而 game_say 不可用时。

【双人联机】
房主先调用 game_start 并 mode=pvp，把返回里的四位房间号念给玩家（开房阶段只报房间号，对手进来后才播「对决开始」）；另一位玩家用同一个智能体说「加入房间 1234」。房间号只在本服务实例有效，没有对手时先用 AI 打，随时可开新局。

【播报】
把工具返回的 text 用口语念给玩家，不要念 JSON、不要提工具名，也不要自己补充数值。

【防护栏】
生命值、能量、回合数、胜负一律以工具返回为准。
工具返回 isError 或提示没听清时，告诉玩家「这一手没生效，再说一次」，不要编造结果，也不要自己替玩家补一招。
```

## 常见问题

**平台连不上 / 工具调用超时**
先分两种情况判断，看 `journalctl -u linx-fighter -f`：

- **完全没有「收到 MCP 请求」日志**：平台的请求没到服务端，是网络或地址问题。先确认控制台填的是 `http://111.62.156.213/mcp`，再在外部机器上 `curl http://111.62.156.213/health`；不通就看云控制台的端口映射（外网 80 → 本机 80）与 `systemctl status nginx`。
- **日志里是 `收到未知路径请求` 且状态 404**：请求到了但方法/路径对不上。看日志里的 `method`、`path`、`host` 三个字段：`POST /mcp` 是新版 Streamable HTTP，服务端已支持；其它路径说明控制台地址填错了。
- **有连接日志但拿不到工具调用**：多半是中间代理缓冲了 SSE。按第 1 节确认 `proxy_buffering off` 与长 `proxy_read_timeout`，再确认 `/mcp` 的响应头是 `text/event-stream`。

**能连上但模型从不调用工具**
意图识别模型不支持 Function Call，或智能体没勾选 MCP；也可能是提示词里没写工具用途。换模型 + 重新保存配置 + 重启设备。

**模型自己编伤害/胜负**
提示词「防护栏」没写清，或工具描述不够明确。可以再补一句「任何战斗结果都必须来自工具返回」。

**改了配置设备没反应**
平台侧配置缓存，保存后需要重启设备或重开体验页。

**服务重启后玩家对局没了**
对局存在进程内存里（`src/store/battles.ts`），重启即丢。需要保留就换 Redis 存储，接口不变。
