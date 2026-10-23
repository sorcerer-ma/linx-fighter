#!/usr/bin/env bash
# 发布到内网服务器：本地编译 → 同步产物 → 安装生产依赖 → 重启 systemd 服务
# 用法：scripts/deploy.sh [root@100.100.61.41] [/opt/linx-fighter]
set -euo pipefail

HOST="${1:-root@100.100.61.41}"
DIR="${2:-/opt/linx-fighter}"
TARGET="${HOST#*@}"
PORT=8000

cd "$(dirname "$0")/.."

echo "==> 编译"
pnpm build

echo "==> 同步到 ${HOST}:${DIR}"
rsync -az --delete --exclude node_modules \
  dist package.json pnpm-lock.yaml pnpm-workspace.yaml \
  "${HOST}:${DIR}/"

echo "==> 安装生产依赖并重启"
ssh "$HOST" "set -e
chown -R linx:linx ${DIR}
cd ${DIR}
su -s /bin/sh linx -c 'cd ${DIR} && HOME=/home/linx pnpm install --prod --frozen-lockfile'
systemctl restart linx-fighter
sleep 1
systemctl is-active linx-fighter
curl -s --max-time 3 http://127.0.0.1:${PORT}/health"

echo
echo "完成：http://${TARGET}:${PORT}/health"
