# 接入灵犀平台

按下面五步把服务接到灵犀设备上。前两步是部署与自检，后三步在灵犀控制台配置。

## 1. 部署

服务部署在七牛云内网机器 `100.100.61.41`，由 systemd 托管；由于内网地址平台访问不到，另起了一个公网隧道把 8000 端口暴露出去：

| 项 | 值 |
| --- | --- |
| 控制台填写的 SSE 地址 | `http://bore.pub:3216/mcp` |
| 备用（内网直连） | `http://100.100.61.41:8000/mcp` |
| 应用服务 | `linx-fighter.service`，`/opt/linx-fighter`，用户 `linx` |
| 公网隧道 | `linx-tunnel.service`，bore 客户端 → `bore.pub:3216` → 本机 `127.0.0.1:8000` |

常用操作：

```bash
systemctl status linx-fighter     # 应用状态
systemctl restart linx-fighter    # 重启应用
journalctl -u linx-fighter -f     # 应用日志（单行 JSON，能看到平台来的 SSE 连接与出招）

systemctl status linx-tunnel      # 隧道状态
journalctl -u linx-tunnel -n 20   # 隧道日志，含 "listening at bore.pub:<端口>"
```

隧道说明：`bore` 是开源的内网穿透客户端，连的公共中继 `bore.pub`，只转发 TCP，不做 TLS；端口 `3216` 是启动时申请的固定端口，中继侧若被占用会换端口，届时以日志里的 `listening at` 为准，并同步改控制台地址。隧道重启（`systemctl restart linx-tunnel`）后端口不变。

发布新版本（在开发机仓库根目录执行，一条命令完成编译、同步、装依赖、重启、自检）：

```bash
scripts/deploy.sh
```

脚本默认发到 `root@100.100.61.41:/opt/linx-fighter`，换机器时传参：`scripts/deploy.sh root@<主机> /opt/linx-fighter`。

部署到其他机器时也可以用 Docker：

```bash
docker build -t linx-fighter .
docker run -d --name linx-fighter -p 8000:8000 -e LOG_LEVEL=info linx-fighter
curl http://127.0.0.1:8000/health
```

反向代理（Nginx）必须为 SSE 关闭缓冲，否则平台收不到 `endpoint` 事件，表现为「工具调用超时 / 连不上」：

```nginx
location /mcp {
    proxy_pass http://127.0.0.1:8000;
    proxy_http_version 1.1;
    proxy_set_header Connection '';
    proxy_set_header Host $host;
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 3600s;
}

location /mcp/message {
    proxy_pass http://127.0.0.1:8000;
    proxy_http_version 1.1;
    proxy_set_header Connection '';
    proxy_set_header Host $host;
    proxy_read_timeout 60s;
}
```

> 平台文档中的示例地址是 `http://...:8000/sse`，说明允许明文 HTTP。有域名和证书时建议走 HTTPS。

## 2. 自检

在开发机或任意能上网的机器上执行：

```bash
# 健康检查（走公网隧道）
curl http://bore.pub:3216/health
# 应看到 event: endpoint 和 /mcp/message?sessionId=... 两行
curl -N -H 'Accept: text/event-stream' --max-time 2 http://bore.pub:3216/mcp
# 完整协议链路（initialize → tools/list → tools/call）
pnpm exec tsx scripts/smoke.ts http://bore.pub:3216
```

`smoke.ts` 会把开局、出招、战况的播报文本打印出来；文本正常说明服务端没问题，剩下的是平台侧配置。

## 3. 控制台：配置自定义 MCP

在灵犀控制台新建「自定义 MCP」，只需要填地址：

| 配置项 | 值 |
| --- | --- |
| 服务名称 | 灵犀对决 |
| SSE 地址 | `http://bore.pub:3216/mcp` |
| 描述 | 语音回合制对战游戏 |

- 设备、智能体、会话三个 `X-Linx-*` 请求头由平台**自动注入**，控制台不用填（服务端在 `src/mcp/context.ts` 读取）。
- 地址填到 `/mcp` 即可。服务端同时支持两种传输：平台若走 Streamable HTTP 会直接 `POST /mcp`（实测就是这样），若走老式 SSE 会先 `GET /mcp` 再由 `endpoint` 事件下发 POST 地址，控制台不用区分。
- 配好后控制台通常有「测试/校验」按钮，能看到 4 个工具（`game_start`、`game_action`、`game_status`、`game_help`）即说明连通。

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
以下操作一律调用工具，不要凭记忆回答：
- game_start：玩家说「开始游戏」「来一局」「重新开始」时调用；玩家说「联机」「开房间」时 mode 填 pvp；玩家报出四位房间号或说「加入房间」时，room 填那四位数字。拿不准参数就把原话放进 text，服务端会识别「开房间」「加入房间1234」；即使直接把这类原话传给 game_action，也会被当成联机操作处理。
- game_action：active 阶段玩家说「普攻 / 攻击 / 强攻 / 大招 / 蓄力」；轮到应对时说「格挡 / 闪避 / 承受」，action 直接填招式或玩家原话。
- game_status：玩家问「战况如何」「我还剩多少血」「第几轮」「房间号多少」时调用。
- game_help：玩家问「怎么玩」「你能做什么」时调用。

【双人联机】
房主先调用 game_start 并 mode=pvp，把返回里的四位房间号念给玩家；另一位玩家用同一个智能体说「加入房间 1234」。房间号只在本服务实例有效，没有对手时先用 AI 打，随时可开新局。

【播报】
把工具返回的 text 用口语念给玩家，不要念 JSON、不要提工具名，也不要自己补充数值。

【防护栏】
血量、真气、回合数、胜负一律以工具返回为准。
工具返回 isError 或提示没听清时，告诉玩家「这一手没生效，再说一次」，不要编造结果。
```

## 常见问题

**平台连不上 / 工具调用超时**
先分两种情况判断，看 `journalctl -u linx-fighter -f`：

- **完全没有「SSE 连接建立」日志**：平台的请求没到服务端，是网络或地址问题。检查隧道是否在跑（`systemctl status linx-tunnel`、`journalctl -u linx-tunnel | grep listening`），确认控制台填的端口与日志一致，再在外部机器上 `curl http://bore.pub:<端口>/health` 验证。
- **日志里是 `收到未知路径请求` 且状态 404**：请求到了但方法/路径对不上。看日志里的 `method`、`path`、`host` 三个字段：`POST /mcp` 是新版 Streamable HTTP，服务端已支持；其它路径说明控制台地址填错了。
- **有 SSE 连接日志但拿不到工具调用**：多半是中间代理缓冲了 SSE。按第 1 节配置 `proxy_buffering off` 与长 `proxy_read_timeout`，再确认 `/mcp` 的响应头是 `text/event-stream`。

**能连上但模型从不调用工具**
意图识别模型不支持 Function Call，或智能体没勾选 MCP；也可能是提示词里没写工具用途。换模型 + 重新保存配置 + 重启设备。

**模型自己编伤害/胜负**
提示词「防护栏」没写清，或工具描述不够明确。可以再补一句「任何战斗结果都必须来自工具返回」。

**改了配置设备没反应**
平台侧配置缓存，保存后需要重启设备或重开体验页。

**服务重启后玩家对局没了**
对局存在进程内存里（`src/store/battles.ts`），重启即丢。需要保留就换 Redis 存储，接口不变。
