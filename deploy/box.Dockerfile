# pagent-box：所有 Agent 共用的一台"电脑"（对应 Grok 的 sand 盒子）。
# 根文件系统可写（Agent 可以 sudo apt install），重建镜像时丢；/home/box 和 /workspace 是持久卷。
# 每个 Agent 一块屏幕：Xvfb + fluxbox + x11vnc/websockify（noVNC）+ Chromium（CDP），截图和点击用 imagemagick / xdotool。
# 引擎：Claude Code（claude -p）和 Codex CLI（codex exec），浏览器 MCP 用 @playwright/mcp 连各自的 Chrome。
FROM node:24-slim
ARG CLAUDE_VERSION=2.1.312
ARG BOX_UID=1000
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl wget git openssh-client gh jq less vim-tiny procps psmisc sudo unzip xz-utils file \
      python3 python3-pip python3-venv build-essential \
      chromium xvfb x11vnc novnc websockify fluxbox xdotool imagemagick fonts-noto-cjk \
 && rm -rf /var/lib/apt/lists/* \
 && npm i -g @anthropic-ai/claude-code@${CLAUDE_VERSION} @openai/codex @playwright/mcp && npm cache clean --force
# 用户 box 的 uid 和宿主部署用户一致：持久卷里的文件宿主上也能直接读写
RUN userdel -r node 2>/dev/null; useradd -u ${BOX_UID} -m -d /home/box -s /bin/bash box \
 && echo 'box ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/box && chmod 440 /etc/sudoers.d/box \
 && mkdir -p /workspace && chown box:box /workspace
# Agent 自己 npm -g / pip --user 装的命令行工具落在持久的 /home/box 里，重建盒子也还在
ENV NPM_CONFIG_PREFIX=/home/box/.npm-global \
    PATH=/home/box/.npm-global/bin:/home/box/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    PIP_BREAK_SYSTEM_PACKAGES=1
USER box
WORKDIR /workspace
