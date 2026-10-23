# 接入灵犀平台

按下面五步把服务接到灵犀设备上。前两步是部署，后三步在灵犀控制台配置。

## 1. 部署到公网

平台要从云端访问这个服务，所以需要公网可达地址。

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

```bash
# 健康检查
curl https://<你的域名>/health
# 应看到 event: endpoint 和 /mcp/message?sessionId=... 两行
curl -N -H 'Accept: text/event-stream' --max-time 2 https://<你的域名>/mcp
# 完整协议链路（initialize → tools/list → tools/call）
pnpm exec tsx scripts/smoke.ts https://<你的域名>
```

`smoke.ts` 会把开局、出招、战况的播报文本打印出来；文本正常说明服务端没问题，剩下的是平台侧配置。

## 3. 控制台：配置自定义 MCP

在灵犀控制台新建「自定义 MCP」，填写：

| 配置项 | 值 |
| --- | --- |
| SSE 地址 | `https://<你的域名>/mcp` |
| 请求头 / Header | `X-Linx-Device-Id: ${deviceId}`、`X-Linx-Agent-Id: ${agentId}`、`X-Linx-Session-Id: ${sessionId}` |

- 地址填到 `/mcp` 即可，POST 地址由服务端 `endpoint` 事件下发，不要求 URL 以 `/sse` 结尾。
- 请求头如果控制台支持变量占位，用平台的占位符；如果只能填静态值，说明该平台的设备上下文头是自动注入的，服务端也能正常拿到（见 `src/mcp/context.ts`）。
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
- game_start：玩家说「开始游戏」「来一局」「重新开始」时调用。
- game_action：玩家说出攻击、闪避、回气，或同义说法（打、砍、躲开、调息、蓄气等）时调用，action 直接填招式（attack / dodge / recover 或玩家原话）。
- game_status：玩家问「战况如何」「我还剩多少血」「几回合了」时调用。
- game_help：玩家问「怎么玩」「你能做什么」时调用。

【播报】
把工具返回的 text 用口语念给玩家，不要念 JSON、不要提工具名，也不要自己补充数值。

【防护栏】
血量、真气、回合数、胜负一律以工具返回为准。
工具返回 isError 或提示没听清时，告诉玩家「这一手没生效，再说一次」，不要编造结果。
```

## 常见问题

**平台连不上 / 工具调用超时**
多半是代理缓冲了 SSE，或代理把连接当短连接关掉。按第 1 节配置 `proxy_buffering off` 与长 `proxy_read_timeout`，再确认 `/mcp` 的响应头是 `text/event-stream`。

**能连上但模型从不调用工具**
意图识别模型不支持 Function Call，或智能体没勾选 MCP；也可能是提示词里没写工具用途。换模型 + 重新保存配置 + 重启设备。

**模型自己编伤害/胜负**
提示词「防护栏」没写清，或工具描述不够明确。可以再补一句「任何战斗结果都必须来自工具返回」。

**改了配置设备没反应**
平台侧配置缓存，保存后需要重启设备或重开体验页。

**服务重启后玩家对局没了**
对局存在进程内存里（`src/store/battles.ts`），重启即丢。需要保留就换 Redis 存储，接口不变。
