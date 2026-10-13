FROM node:26-alpine

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --chown=node:node src ./src
COPY --chown=node:node scripts/storage.ts ./scripts/storage.ts
RUN mkdir -p /app/data /app/backups && chown node:node /app/data /app/backups

ENV NODE_ENV=production \
    PORT=19888 \
    HOST=0.0.0.0 \
    DATABASE_PATH=/app/data/app.db \
    DEMO_SEED=false \
    COOKIE_SECURE=false

USER node
EXPOSE 19888
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:19888/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "src/app/server.ts"]
