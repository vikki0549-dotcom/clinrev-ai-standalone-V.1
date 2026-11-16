# ---- build: install all deps (incl. dev) to vendor browser libs and build index.html
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=optional --no-audit --no-fund
COPY tools ./tools
COPY original ./original
COPY public ./public
RUN node tools/copy-vendor.js \
 && node tools/make-index.js original/clinrev-ai.html public/index.html

# ---- runtime deps only
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --omit=optional --ignore-scripts --no-audit --no-fund && npm cache clean --force

# ---- runtime image
FROM node:20-alpine
ENV NODE_ENV=production PORT=3000
WORKDIR /app
RUN apk add --no-cache tini
COPY --from=deps --chown=root:root /app/node_modules ./node_modules
COPY --chown=root:root package.json ./
COPY --chown=root:root server ./server
COPY --chown=root:root db ./db
COPY --chown=root:root tools ./tools
COPY --from=build --chown=root:root /app/public ./public
# Files are root-owned and read-only to the app user; the app writes nothing to disk.
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/healthz >/dev/null || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server/index.js"]
