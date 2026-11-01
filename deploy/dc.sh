#!/bin/sh
# docker compose 包装：./deploy/dc.sh logs -f pagentd / restart pagentd / ps
set -eu
. "$(dirname "$0")/env.sh"
exec docker compose -f "$DEPLOY_DIR/compose.yaml" "$@"
