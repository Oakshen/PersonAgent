#!/bin/sh
# -p 模式下的中断：对整个进程组发 SIGINT，然后检查残留进程，再 --resume 续跑
cd /work; rm -f slept.txt
S='{"hooks":{"PreToolUse":[{"matcher":"*","hooks":[{"type":"command","command":"/opt/hooks/policy.sh","timeout":600}]}]}}'
setsid claude -p --output-format json --permission-mode default --strict-mcp-config --settings "$S" \
  "前台用 Bash 执行：node -e 'setTimeout(()=>require(\"fs\").writeFileSync(\"slept.txt\",\"done\"),40000)'（timeout 设 60000，不要后台运行），完成后告诉我。" > /tmp/int.json 2>/tmp/int.err &
PID=$!
sleep 12
echo "== before: $(ps -eo pid,pgid,args | grep -E 'setTimeout' | grep -v grep)"
kill -INT -$PID; T=$(date +%s)
wait $PID; echo "exit=$? after $(( $(date +%s) - T ))s"
sleep 1; echo "== after: $(ps -eo pid,args | grep -E 'setTimeout|claude' | grep -v grep || echo none)"
echo "slept.txt: $(ls slept.txt 2>/dev/null || echo absent)"
echo "stdout: $(head -c 300 /tmp/int.json)"; echo "stderr: $(head -c 200 /tmp/int.err)"
SID=$(ls -t /home/agent/.claude/projects/-work/*.jsonl | head -1 | xargs basename | sed 's/.jsonl//')
echo "== resume $SID"
/opt/hooks/run-p.sh "刚才那个命令被我中断了。你上一条让你做什么？只用一句话回答，不要执行任何工具。" --resume "$SID"
