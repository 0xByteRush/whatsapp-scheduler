FROM node:24-slim

ENV NODE_ENV=production \
    DATA_DIR=/data \
    HOST=0.0.0.0 \
    PORT=3737

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY public ./public

RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3737

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
  CMD node -e "fetch('http://localhost:3737/healthz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

# Signals go straight to node so shutdown can finish an in-flight send.
CMD ["node", "src/index.js"]
