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

# Copy built artifacts from builder
COPY --from=builder /app/dist ./dist

# Expose the default port
ENV PORT=7860
EXPOSE 7860

# Set Node environment to production
ENV NODE_ENV=production

# Health check for container orchestration
HEALTHCHECK --interval=10s --timeout=3s --retries=3 \
  CMD wget --spider -q http://localhost:7860/health || exit 1

# Start the server
CMD ["node", "dist/index.js"]
