#!/bin/sh
# 用法：turn.sh <runId> <cmd> [args...]
# setsid 让命令成为新进程组的组长，pgid 写进 /tmp，控制面中断时对整组发信号。
RUN="$1"; shift
exec setsid -w sh -c 'echo $$ > "/tmp/pagent-run-$0.pid"; exec "$@"' "$RUN" "$@"
