#!/bin/sh
# 在部署机上启动 pagent：构建盒子 / pagentd 镜像，起 egress + pagentd（盒子由 pagentd 拉起）。
set -eu
. "$(dirname "$0")/env.sh"
cd "$DEPLOY_DIR"
mkdir -p "$PAGENT_DATA" "$PAGENT_RUN"
[ -f "$PAGENT_DATA/egress-rules.json" ] || echo '{}' > "$PAGENT_DATA/egress-rules.json"
docker build -q -t pagent-box --build-arg BOX_UID="$PAGENT_UID" -f box.Dockerfile . >/dev/null
docker compose up -d --build "$@"
