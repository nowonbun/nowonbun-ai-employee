FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.web.json ./
COPY app ./app
COPY web ./web
COPY public ./public
RUN npm run build

FROM node:24-bookworm-slim
WORKDIR /app
RUN npm install -g @openai/codex@0.147.0 --no-audit --no-fund && mkdir -p /data /codex-home /workspace && chown -R node:node /data /codex-home /workspace
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
USER node
ENV PORT=3000 HOST=0.0.0.0 DB_PATH=/data/ai-employee.sqlite WORKSPACE_ROOT=/workspace CODEX_HOME=/codex-home
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node","dist/main.js"]
