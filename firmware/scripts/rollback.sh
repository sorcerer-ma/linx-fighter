#!/bin/bash
# 用备份的原始 ota_0 镜像回滚 app 分区
set -euo pipefail
PORT=${1:-${PORT:-/dev/cu.usbmodem2101}}
/tmp/linxvenv/bin/esptool -p "$PORT" -b 460800 write-flash 0x20000 "$(cd "$(dirname "$0")/../../backup" && pwd)/ota0-original.bin"
echo "ROLLBACK_OK"
