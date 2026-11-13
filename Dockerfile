# The chat app for one company's own server: the pages people open, and the server that signs for
# them. Built in three steps so the image that runs holds no build tools and no source code.
ARG CA_VERSION=1.5.22

# 1. Build the pages, and pack the server into one file.
FROM node:24-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json vite.config.ts ./
COPY server server
COPY web web
RUN npx vite build \
 && npx esbuild server/index.ts --bundle --platform=node --format=esm --packages=external --outfile=build/server.mjs \
 && cp server/operator.mjs server/backup.mjs build/

# 2. The few packages the server needs when it runs.
FROM node:24-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# 3. Fabric CA's own client: the app uses it to have a certificate signed for each new person.
FROM hyperledger/fabric-ca:${CA_VERSION} AS ca

FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=ca /usr/local/bin/fabric-ca-client /usr/local/bin/fabric-ca-client
COPY --from=deps /app/node_modules node_modules
COPY --from=build /src/dist dist
COPY --from=build /src/build build
COPY package.json ./
# The app runs as an ordinary user. These two folders are the only places it writes.
RUN mkdir -p /data /run/chat && chown node:node /data /run/chat
USER node
ENV CHAT_NODE=/app-config \
    CHAT_DATA=/data \
    CHAT_TMP=/run/chat \
    PORT=8080
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "build/server.mjs"]
