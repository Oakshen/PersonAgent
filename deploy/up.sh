#!/bin/sh
# 在部署机上启动 pagent：构建 worker / pagentd 镜像，起 egress + pagentd。
set -eu
. "$(dirname "$0")/env.sh"
cd "$DEPLOY_DIR"
mkdir -p "$PAGENT_DATA" "$PAGENT_RUN"
[ -f "$PAGENT_DATA/egress-rules.json" ] || echo '{}' > "$PAGENT_DATA/egress-rules.json"
docker build -q -t pagent-worker -f worker.Dockerfile . >/dev/null
docker compose up -d --build "$@"
