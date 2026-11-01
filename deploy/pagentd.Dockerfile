FROM docker:cli AS dockercli
FROM node:24-slim
COPY --from=dockercli /usr/local/bin/docker /usr/local/bin/docker
