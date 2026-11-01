# 手机对战平台：多房间与公开大厅

[返回架构与设计决策](architecture.md) · [沙箱说明](../testing/sandbox.md)

日期：2026-11-01。状态：仓库已实现并通过本地回归；演示环境已部署并完成双人开房冒烟，公网 HTTPS 与真机体验仍待验收。

硬件数量有限，同事想先体验玩法时，沙箱可以充当一个临时的手机对战平台：没有账号、没有安装包，打开网页就能开房；默认点按钮出招，也可以继续用语音或键盘。它不替代灵矽平台接入、真机验收或正式产品形态，只是把现有沙箱从「本机双窗口调试」扩展到「同一服务下多间房、多人同时玩」。

## 玩家怎么用

1. 手机或电脑打开沙箱页面，进入大厅。
2. 点「开一间房」拿到四位房号和邀请链接；把链接发给朋友，对方打开后自动加入；也可以在大厅输入房号。
3. 两人各看自己的视角，轮流出招。出招区默认只显示按钮；能量不够或不在自己回合时禁用，原因保留在无障碍标签，不再占用屏幕文字。
4. 想说话时点底部麦克风图标，或用键盘输入，说「强攻」「格挡」等原话，和按钮走同一条服务端入口；语音与键盘不再在页面上配说明文字。
5. 对局结束点「回到大厅」；进行中想离开点「退出房间」，会确认「现在退出会判负」。

大厅只展示房间号、等待/对战中、轮次和更新时间，不展示设备号。轮询只在页面可见且当前没有对局时进行，进入对局后自动停止。

## 架构

```text
手机浏览器
  ├─ GET  /api/lobby ──▶ sandbox 服务 ──▶ 游戏服务 GET /rooms（只读读模型）
  ├─ GET  /api/events ─▶ sandbox 服务 ──▶ 游戏服务 GET /events（SSE 代理）
  └─ POST /api/say ────▶ sandbox 服务 ──▶ MCP game_say（原话）
```

- 大厅是**只读快照**，不调 `GameService`、不推进对局，也不参与裁决。
- 按钮不直接调游戏接口，只把「普攻」「格挡」这类中文原话交给 `/api/say`；规则、轮次、能量与胜负仍只由服务端规则引擎决定。
- 屏幕按固件单视图：左上角是自己、右上角是对手的大招徽记，底部两行资源第一行自己、第二行对手；徽记三态用 `sandbox/public/assets/ult-ready.svg`、`ult-idle.svg`、`ult-used.svg`，页面只切 `data-availability`，不自己画状态。
- 沙箱仍只通过 HTTP/MCP 使用游戏服务，不引用 `src/` 的内部业务实现。

## 接口

### GET /rooms（游戏服务）

公开、只读、允许跨域，`Cache-Control: no-store`。只收录对局仍在 `battle` 阶段的四人房：

```json
{
  "ok": true,
  "generatedAt": 1762000000000,
  "rooms": [
    { "code": "1234", "status": "waiting", "round": 1, "createdAt": 1762000000000, "updatedAt": 1762000000000 }
  ],
  "waiting": 1,
  "playing": 0
}
```

等待房按开房时间升序排在前面，对战中的房按最近活动降序排在后面，默认最多 50 间；计数只算截断后仍在列表里的房间。没有设备身份字段，字段约定见 `src/game/lobby.ts`。

### GET /api/lobby（沙箱服务）

沙箱代理上面的接口，供页面轮询：

- 成功：`{ "ok": true, ... }`，字段与 `/rooms` 相同；
- 上游不可达或协议异常：HTTP 仍为 200，返回 `{ "ok": false, "rooms": [], "waiting": 0, "playing": 0, "generatedAt": null, "error": "upstream_unreachable" }`，页面提示「大厅暂时读不到」，手动开房和按房号加入不受影响。

## 部署

沙箱原先没有生产构建产物；现在单独编译，不影响游戏服务：

```bash
pnpm build:sandbox     # 输出 dist-sandbox/
```

产物包含编译后的 `dist-sandbox/sandbox/server.js`、静态页面与提示词配置。目标机安装：

- `deploy/linx-sandbox.service`：systemd 单元，入口 `/opt/linx-fighter/dist-sandbox/sandbox/server.js`；
- `deploy/linx-sandbox.env.example`：复制到 `/etc/linx-sandbox.env`，按实际地址改 `SANDBOX_UPSTREAM`；
- `deploy/nginx-linx-sandbox.conf`：独立端口 10660 反代 127.0.0.1:8100，SSE 关闭缓冲、长超时；
- `scripts/deploy-sandbox.sh`：编译、同步、重启并请求一次 `/api/health`。

首次安装（目标机已安装 Node、pnpm 与 nginx）：

```bash
# 在仓库根目录
pnpm build:sandbox
sudo install -m 644 deploy/linx-sandbox.service /etc/systemd/system/
sudo install -m 600 deploy/linx-sandbox.env.example /etc/linx-sandbox.env
sudo install -m 644 deploy/nginx-linx-sandbox.conf /etc/nginx/conf.d/
sudo systemctl daemon-reload
sudo systemctl enable --now linx-sandbox
sudo nginx -t && sudo systemctl reload nginx
curl -s http://127.0.0.1:8100/api/health
```

后续更新用 `scripts/deploy-sandbox.sh` 即可。手机访问 `http://<公网地址>:10660/`；语音需要 HTTPS，按钮与键盘在 HTTP 下可用。

### 演示环境（只有 IP、共享网关）

当前演示机 `111.62.156.213` 是共享 NAT，只有 `10659 → 内网 80` 这一条 Web 映射；`10660` 实际被网关分给另一台机器，不能照搬上面的独立端口方案。演示环境实际布置：

- 正式游戏服务仍在 8000，不重启、不改数据；
- 试玩实例 `linx-fighter-demo` 监听 8020（`deploy/linx-fighter-demo.service` + `/etc/linx-fighter-demo.env` 的 `PORT=8020`），沙箱监听 8100；
- nginx 在主 server 上把 `/`、`/api/`、`/assets/`、`/companion.css` 和 `/[A-Za-z0-9_-]+\.js` 转到沙箱，其余仍回 8000；游戏 `/mcp`、`/state`、`/events`、`/device/*`、`/admin`、`/health` 不受影响。

入口是 `http://111.62.156.213:10659/`。这是按现有网关映射做的演示布置，不是通用部署模板；换环境先确认公网端口实际落到哪个内网端口。

## HTTPS 与语音

浏览器只在安全上下文（HTTPS 或 localhost）提供 `getUserMedia`。`http://IP:端口` 不是安全上下文，页面里的麦克风按钮不可用，按钮、键盘输入不受影响。

这不是「只能按键」：手机输入法自带的语音听写可以在输入框里说话转文字，再点发送，不需要 HTTPS。

如果希望恢复页内持续语音，需要 HTTPS：

- 只有 IP 也能申请受信任证书。Let's Encrypt 已签发 IP 地址证书（6 天有效期，certbot ≥ 5.4 用 `--ip-address`）。但 IP 标识只支持 HTTP-01（公网 80）或 TLS-ALPN-01（公网 443），不支持 DNS-01；必须先让网关把公网 80 或 443 映射到本机，再配自动续期和 nginx reload。
- 不想动 80/443 时，可以用出站隧道（Cloudflare Tunnel、localhost.run 等）拿到受信任 HTTPS 地址，不用域名，也不用用户装证书；代价是多一个第三方依赖、地址可能变化。本次只验证了 localhost.run 能建立可用的 HTTPS 隧道，未做长期稳定性与国内网络验证。
- 免费二级域名 + DNS-01 也可行，但需要注册账号并配置 DNS API。

内部试玩优先用 HTTP + 按钮 + 键盘听写；要做页内语音，先选一条 HTTPS 路径并做真机验收。

关键配置：

| 变量 | 说明 |
| --- | --- |
| `SANDBOX_UPSTREAM` | 游戏服务地址，默认 `http://127.0.0.1:8000` |
| `SANDBOX_EVENTS_URL` | 公网部署必须设为 `/api/events`，让页面走沙箱同源 SSE 代理；不设时页面会尝试直连游戏服务的 `/events` 端口 |
| `SANDBOX_HOST` / `PORT` | 默认 `0.0.0.0:8100`；反代场景可改 `127.0.0.1` |
| `SANDBOX_AGENT_ID` | 沙箱 Agent 身份，默认 `linx-sandbox` |
| `SANDBOX_TTS_BRIDGE` | 仅本机情绪音频桥接时设为 `local`，转发到固定 `127.0.0.1:18391` |

页面使用绝对 `/api/*` 路径，不适合挂在别的站点子路径下；用独立端口或独立域名。浏览器麦克风需要 HTTPS 安全上下文，纯 HTTP 下按钮和键盘仍可用，语音不可用。

## 精灵与语音

大厅的「选择精灵」提供灿灿、擎苍、小满三只预设角色，对应 `config/companion-profiles/` 下的三份人格；选定后，沙箱 Agent 的第三层提示词与浏览器音色一起切换，第一、二层执行契约不变。出招按钮右侧标出所需能量，`⚡0` 不显示。

浏览器 TTS 不需要 HTTPS，但 iOS/Safari 通常要求先有一次用户手势。页面在第一次点按或按键时用一条静音 utterance 预热 `speechSynthesis`，之后回复才出声；这不改变服务端事实，也不把「合成成功」当作「已经播放」。若预热后仍无声，先排查设备静音键、媒体音量和浏览器语音能力，不能仅凭页面代码判断已恢复。

## 限制与边界

- 房间与对局都在内存里，默认 30 分钟无活动过期（`BATTLE_TTL_SECONDS`）；服务重启即清空，没有账号、数据库或历史战绩。
- 一个玩家同一时间只属于一间有效房间；换房先加入新房间，失败保留原局。
- 双人房在房主或加入者离开时关闭，另一方回到大厅；暂不支持同房再来一局、观战、匹配或好友系统。
- 大厅最多返回 50 间等待/对战中房间，不返回满员或已结束的对局。
- 只适合内部演示与试玩，不作为对外服务承诺；接真实并发前需要处理存储、限流与运维。

## 验证

- `pnpm typecheck`、`pnpm test`、`pnpm build`、`pnpm build:sandbox` 通过。
- 新增 `test/lobby.test.ts`、`test/sandbox-lobby.test.ts`、`test/sandbox-actions.test.ts`，并在 `test/sandbox.test.ts` 覆盖 `/api/lobby` 的成功与上游不可达降级。
- headless Chrome 在 390×844 与 320×568 下检查大厅、等待房、主动出招、应对、双人结束与单人结束；320 宽无横向溢出，按钮触控高度 44px；按钮耗能标注与三态大招图标已截图核对。
- 未验证：iOS Safari / Android 真机、真实语音识别与 TTS 播放（只验证了会调用 `speechSynthesis`）、`env(safe-area-inset-*)` 与虚拟键盘的实际表现；公网并发与长时间稳定性也需在部署环境另行验证。

## 关联

- [沙箱说明](../testing/sandbox.md)：本地启动、身份、接口与回归命令。
- [架构与设计决策](architecture.md)：对局归属、串行写入与只读读模型。
- [手机模拟硬件演示](../product/mobile-demo-design.md)：产品侧的演示边界；本文件只描述沙箱试玩平台。
