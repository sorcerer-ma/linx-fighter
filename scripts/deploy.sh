#!/usr/bin/env bash
# 发布到部署服务器：本地编译 → 同步产物 → 安装生产依赖 → 重启 systemd 服务
# 用法：scripts/deploy.sh [root@linx-fighter-las] [/opt/linx-fighter]
set -euo pipefail

HOST="${1:-root@linx-fighter-las}"
DIR="${2:-/opt/linx-fighter}"
TARGET="${HOST#*@}"
PORT=8000

cd "$(dirname "$0")/.."

echo "==> 编译"
pnpm build

echo "==> 同步到 ${HOST}:${DIR}"
rsync -az --delete --exclude node_modules --exclude .env \
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
echo -n '直连：'; curl -s --max-time 3 http://127.0.0.1:${PORT}/health
echo -n '反代：'; curl -s --max-time 3 http://127.0.0.1/health"

echo
echo "完成：${TARGET}（本机 ${PORT} 端口已自检，公网访问走 nginx 的 80 端口）"
