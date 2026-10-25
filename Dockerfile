# Сборка фронтенда и сервера одной командой: docker compose up --build

FROM node:22-alpine AS webapp
WORKDIR /build/webapp
COPY webapp/package.json webapp/package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY webapp/ ./
RUN npm run build

FROM node:22-alpine AS server
WORKDIR /build/server
COPY server/package.json server/package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY server/ ./
COPY data /build/data
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    NODE_EXTRA_CA_CERTS=/app/server/certs/russian_trusted_ca.pem \
    DATA_DIR=/app/data \
    MIGRATIONS_DIR=/app/server/migrations \
    WEBAPP_DIST=/app/webapp/dist
WORKDIR /app/server
# 7z — архивы открытых данных Росаккредитации (импорт `node dist/opendata/cli.js fsa`)
RUN apk add --no-cache p7zip
COPY --from=server /build/server/package.json ./package.json
COPY --from=server /build/server/node_modules ./node_modules
COPY --from=server /build/server/dist ./dist
COPY server/migrations ./migrations
COPY server/certs ./certs
COPY data /app/data
COPY --from=webapp /build/webapp/dist /app/webapp/dist
# Том opendata (архивы и отчёты импорта): новый том наследует владельца папки из образа
RUN mkdir -p /opendata && chown node:node /opendata
USER node
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "dist/index.js"]
