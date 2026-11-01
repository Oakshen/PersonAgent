# 被 up.sh / dc.sh source：部署用的环境变量
DEPLOY_DIR="$(cd "$(dirname "$0")" && pwd)"
export PAGENT_SRC="$(cd "$DEPLOY_DIR/.." && pwd)"
export PAGENT_DATA="${PAGENT_DATA:-$HOME/pagent/data}"
export PAGENT_RUN="${PAGENT_RUN:-$HOME/pagent/run}"
export PAGENT_UID="$(id -u)"
export DOCKER_GID="$(getent group docker | cut -d: -f3)"
# 复用宿主已登录的 claude 订阅；设为空字符串则需在盒子里登录
export PAGENT_HOST_CRED="${PAGENT_HOST_CRED-$HOME/.claude/.credentials.json}"
# 可选：家里住宅线路的代理地址（含认证，所以放在数据目录里，不进仓库）
if [ -f "$PAGENT_DATA/home-proxy" ]; then export PAGENT_HOME_PROXY="$(cat "$PAGENT_DATA/home-proxy")"; fi
