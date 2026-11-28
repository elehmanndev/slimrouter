# syntax=docker/dockerfile:1.7
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# Runtime. Besides the gateway it runs local (stdio) MCP servers, so it carries the launchers those
# use: node/npx, python3 with uv/uvx, git (uvx --from git+...), and setpriv (util-linux) to run a
# server as another uid. Browser MCPs (playwright, cloakbrowser) download their browser into
# /data/cache on first use; their shared libraries come from the chromium package's dependencies.
FROM node:22-bookworm-slim AS runner
WORKDIR /app
ARG UV_VERSION=0.13.9
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git python3 python3-venv util-linux tini \
      libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2 libpango-1.0-0 libcairo2 fonts-liberation \
 && rm -rf /var/lib/apt/lists/* \
 && curl -fsSL "https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-x86_64-unknown-linux-gnu.tar.gz" | tar -xz -C /usr/local/bin --strip-components=1 \
 && uv --version
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=20128 \
    HOSTNAME=0.0.0.0 \
    DATA_DIR=/data \
    HOME=/data/home \
    XDG_CACHE_HOME=/data/cache \
    NPM_CONFIG_CACHE=/data/cache/npm \
    UV_CACHE_DIR=/data/cache/uv \
    UV_TOOL_DIR=/data/cache/uv-tools \
    PLAYWRIGHT_BROWSERS_PATH=/data/cache/ms-playwright
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
RUN mkdir -p /data && chown -R node:node /data /app
# Runs as root only when a stdio MCP needs to drop to another uid with setpriv (set USER at run time
# with --user 0); by default it runs as the unprivileged node user.
USER node
EXPOSE 20128
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:20128/api/admin/session').then(r=>process.exit(r.ok||r.status===401?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.js"]
