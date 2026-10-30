# One container: Express API + built React app + the Qloo harness (qloo mcp runs as a child process).
# Serverless functions can't host qloo mcp; Cloud Run containers can.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    PORT=8080 \
    QLOO_BASE_URL=https://hackathon.api.qloo.com \
    QLOO_TRUSTED_BASE_URL=https://hackathon.api.qloo.com \
    QLOO_HOME=/tmp/qloo \
    DB_PATH=/tmp/gloo.db
RUN npm install --global @qloo/qloo-harness@0.1.26 && npm cache clean --force
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --omit=dev -w server && npm cache clean --force
COPY server/src server/src
COPY --from=build /app/web/dist web/dist
USER node
EXPOSE 8080
CMD ["node", "server/src/boot.mjs"]
