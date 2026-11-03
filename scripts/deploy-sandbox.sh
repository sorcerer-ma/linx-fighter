#!/usr/bin/env bash
# 发布手机沙箱：本地编译 → 同步 dist-sandbox → 重启 systemd 服务
# 用法：scripts/deploy-sandbox.sh [root@linx-fighter-las] [/opt/linx-fighter]
# 前置：目标机已安装 deploy/linx-sandbox.service 与 /etc/linx-sandbox.env
set -euo pipefail

HOST="${1:-root@linx-fighter-las}"
DIR="${2:-/opt/linx-fighter}"

cd "$(dirname "$0")/.."

echo "==> 编译沙箱"
pnpm build:sandbox

echo "==> 同步到 ${HOST}:${DIR}/dist-sandbox"
ssh "$HOST" "mkdir -p ${DIR}/dist-sandbox"
rsync -az --delete dist-sandbox/ "${HOST}:${DIR}/dist-sandbox/"

echo "==> 重启沙箱并自检"
ssh "$HOST" "set -e
chown -R linx:linx ${DIR}/dist-sandbox
systemctl restart linx-sandbox
sleep 1
systemctl is-active linx-sandbox
echo -n '沙箱健康：'; curl -s --max-time 3 http://127.0.0.1:8100/api/health"

echo
echo "完成：手机访问 nginx 实际映射的 Web 端口（示例 10660，演示机是 10659）；语音需另配 HTTPS，或改用按钮与键盘听写。"
