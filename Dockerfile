# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Native build tools for better-sqlite3
RUN apk add --no-cache python3 make g++

# Enable corepack and activate pnpm
RUN corepack enable && corepack prepare pnpm@10.32.1 --activate

# Copy package + lock files first for caching
COPY package.json pnpm-lock.yaml .npmrc ./
COPY tsconfig.json ./

# Install all dependencies. better-sqlite3's native build runs because it is
# allowlisted in package.json pnpm.onlyBuiltDependencies (pnpm 10 blocks
# dependency build scripts by default).
RUN pnpm install --frozen-lockfile

# Copy source code
COPY src ./src

# Build TypeScript to dist/
RUN pnpm run build

# Production stage
FROM node:20-alpine AS runner

WORKDIR /app

# Enable corepack and activate pnpm
RUN corepack enable && corepack prepare pnpm@10.32.1 --activate

# Copy package + lock files again for production install
COPY package.json pnpm-lock.yaml .npmrc ./

# Native build tools for better-sqlite3
RUN apk add --no-cache python3 make g++ && \
    pnpm install --frozen-lockfile --prod && \
    apk del python3 make g++

# Litestream (static binary) for SQLite replication to GCS on Cloud Run.
# Pinned version + checksum; a stale pin fails loudly at build time.
ARG LITESTREAM_VERSION=0.5.16
ARG LITESTREAM_SHA256=9e29112380a942e4a62ee07773684396cb8b308dc4d67e130bef41f75e937f0a
RUN wget -qO /tmp/litestream.tar.gz \
      "https://github.com/benbjohnson/litestream/releases/download/v${LITESTREAM_VERSION}/litestream-${LITESTREAM_VERSION}-linux-x86_64.tar.gz" && \
    echo "${LITESTREAM_SHA256}  /tmp/litestream.tar.gz" | sha256sum -c - && \
    tar -xzf /tmp/litestream.tar.gz -C /usr/local/bin litestream && \
    rm /tmp/litestream.tar.gz

# Copy built artifacts from builder
COPY --from=builder /app/dist ./dist
COPY scripts/entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh

# Expose the default port
ENV PORT=7860
EXPOSE 7860

# Set Node environment to production
ENV NODE_ENV=production

# Health check for container orchestration
HEALTHCHECK --interval=10s --timeout=3s --retries=3 \
  CMD wget --spider -q http://localhost:7860/health || exit 1

# Start the server (entrypoint wraps with litestream when LITESTREAM_REPLICA_URL is set)
CMD ["./entrypoint.sh"]
