FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc --outDir dist --rootDir . && node --check dist/src/cli.js
RUN npm prune --omit=dev --ignore-scripts

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY config ./config
COPY ops/run-worker-locked.sh ./ops/run-worker-locked.sh
RUN command -v flock && chmod 755 ops/run-worker-locked.sh && chmod 644 package.json && find config -type d -exec chmod 755 {} + && find config -type f -exec chmod 644 {} + && mkdir -p runtime && chown node:node runtime
USER node
RUN node --input-type=module -e "import {loadChains} from './dist/src/config.js'; if (loadChains().length === 0) throw new Error('Registry is not readable by the runtime user');"
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:9091/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["flock", "--no-fork", "--exclusive", "--nonblock", "/app/runtime/worker.flock", "/app/ops/run-worker-locked.sh"]
CMD ["node", "dist/src/cli.js", "run", "--config", "config/rebalancer.local.json"]
