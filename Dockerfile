# syntax=docker/dockerfile:1
# stackprint API. Slim by default; build with --build-arg WITH_BROWSER=1 for deep mode (Chromium headless shell).

FROM node:24-bookworm-slim AS build
WORKDIR /app
# better-sqlite3 normally uses a prebuilt binary; these are the fallback if it has to compile.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev \
    && rm -rf node_modules/better-sqlite3/deps node_modules/better-sqlite3/src

FROM node:24-bookworm-slim
ARG WITH_BROWSER=0
ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    HOST=:: \
    PORT=8080 \
    DB_PATH=/data/stackprint.db \
    DEEP_ENABLED=false
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json LICENSE THIRD_PARTY_NOTICES.md README.md ./
COPY fingerprints ./fingerprints
RUN if [ "$WITH_BROWSER" = "1" ]; then \
      npx playwright install --with-deps --only-shell chromium && rm -rf /var/lib/apt/lists/*; \
    else \
      rm -rf node_modules/playwright node_modules/playwright-core; \
    fi && mkdir -p /data
EXPOSE 8080
CMD ["node", "dist/server/index.js"]
