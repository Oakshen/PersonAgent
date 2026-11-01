FROM node:24-slim
WORKDIR /app
RUN npm i @modelcontextprotocol/sdk zod && npm cache clean --force
COPY server.mjs .
CMD ["node", "server.mjs"]
