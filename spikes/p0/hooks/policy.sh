#!/bin/sh
# PreToolUse hook 原型：stdin 是工具调用 JSON，stdout 返回决定。真实产品里这里改成 curl 控制面并阻塞等审批。
IN=$(cat)
TOOL=$(printf '%s' "$IN" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).tool_name))')
echo "$(date +%T) $TOOL $IN" >> /work/.hook.log
case "$TOOL" in
  Bash)  [ -n "$HOOK_DELAY" ] && sleep "$HOOK_DELAY"   # 模拟等手机审批
         D=allow ;;
  *)     D=deny ;;
esac
printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"%s","permissionDecisionReason":"pagent hook: %s %s"}}\n' "$D" "$D" "$TOOL"
