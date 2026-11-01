#!/bin/sh
# P4 一次性迁移：把 v3"每个 Bot 一个容器"的家目录搬进共享盒子。先停 pagentd（./deploy/dc.sh stop pagentd）。
# 原来的 $PAGENT_DATA/bots 原样保留作备份。可以重复执行，已迁移的 Agent 会跳过。
set -eu
. "$(dirname "$0")/env.sh"
BOX="$PAGENT_DATA/box/home/.pagent"
mkdir -p "$BOX/agents" "$BOX/skills" "$PAGENT_DATA/box/workspace"
for dir in "$PAGENT_DATA"/bots/bot_*; do
  [ -d "$dir/home/.claude" ] || continue
  id=$(basename "$dir")
  dst="$BOX/agents/$id/claude"
  if [ -e "$dst" ]; then echo "跳过 $id（已迁移）"; continue; fi
  mkdir -p "$dst"
  cp -a "$dir/home/.claude/." "$dst/"
  rm -f "$dst/.credentials.json"          # 网关会链接到宿主的订阅凭据
  # 自己装的 skill 并进共享目录（同名的先到先得）
  if [ -d "$dst/skills" ] && [ ! -L "$dst/skills" ]; then
    for s in "$dst/skills"/*; do
      [ -e "$s" ] || continue
      [ -e "$BOX/skills/$(basename "$s")" ] || mv "$s" "$BOX/skills/"
    done
    rm -rf "$dst/skills"
  fi
  # claude 按工作目录存会话记录：以前是 /work，盒子里是 /workspace
  if [ -d "$dst/projects/-work" ]; then mv "$dst/projects/-work" "$dst/projects/-workspace"; fi
  if [ -n "$(ls -A "$dir/work" 2>/dev/null)" ]; then
    mkdir -p "$PAGENT_DATA/box/workspace/$id"
    cp -a "$dir/work/." "$PAGENT_DATA/box/workspace/$id/"
  fi
  echo "已迁移 $id"
done

# 删掉每个 Bot 一个的旧容器，出口白名单里也去掉它们
docker ps -aq --filter label=pagent.bot | xargs -r docker rm -f
RULES="$PAGENT_DATA/egress-rules.json" node -e '
  const fs = require("fs"); const f = process.env.RULES;
  const r = JSON.parse(fs.readFileSync(f, "utf8"));
  for (const k of Object.keys(r)) if (k.startsWith("pagent-bot-")) delete r[k];
  fs.writeFileSync(f + ".tmp", JSON.stringify(r, null, 2)); fs.renameSync(f + ".tmp", f);'
echo "完成。旧目录 $PAGENT_DATA/bots 保留作备份，确认无误后可以删。"
