#!/bin/sh
# 用法：run-p.sh "<prompt>" [--resume <id>]   以 claude -p + PreToolUse hook 跑一轮
P="$1"; shift
S='{"hooks":{"PreToolUse":[{"matcher":"*","hooks":[{"type":"command","command":"/opt/hooks/policy.sh","timeout":600}]}]}}'
cd /work
T0=$(date +%s)
claude -p --output-format json --permission-mode default --strict-mcp-config --settings "$S" "$@" "$P" > /tmp/out.json
echo "exit=$? elapsed=$(( $(date +%s) - T0 ))s"
node -e 'const r=JSON.parse(require("fs").readFileSync("/tmp/out.json","utf8"));console.log("session",r.session_id,"turns",r.num_turns,"subtype",r.subtype,"denials",JSON.stringify(r.permission_denials));console.log(r.result)'
