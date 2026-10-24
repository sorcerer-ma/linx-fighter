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
| 运行配置 | `/etc/linx-fighter.env`（端口、`BATTLE_TTL_SECONDS`、`OPENROUTER_API_KEY`），不进仓库 |

常用操作：

```bash
systemctl status linx-fighter     # 应用状态
systemctl restart linx-fighter    # 重启应用
journalctl -u linx-fighter -f     # 应用日志（单行 JSON，能看到平台来的连接与出招）

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

## 5. 智能体提示词模板

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
