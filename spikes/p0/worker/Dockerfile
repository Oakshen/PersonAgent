FROM node:24-slim
ARG CLAUDE_VERSION=2.1.312
RUN apt-get update && apt-get install -y --no-install-recommends curl procps ca-certificates git && rm -rf /var/lib/apt/lists/* \
 && npm i -g @anthropic-ai/claude-code@${CLAUDE_VERSION} && npm cache clean --force
RUN useradd -u 10001 -m -d /home/agent agent
