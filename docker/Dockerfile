# syntax=docker/dockerfile:1
# Build stage
FROM node:22-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a AS builder

# Set production environment
ENV NODE_ENV=production

WORKDIR /app

# Copy package files first for better layer caching
COPY package.json pnpm-lock.yaml ./

# Enable corepack and install dependencies
RUN corepack enable && \
    pnpm install --frozen-lockfile

# Copy source code
COPY . .

# Build the application
RUN pnpm run build

# Production stage
FROM nginx:1.31.10-alpine@sha256:7fc0fb4af7bf006aeb31aea88069976060f8f0a0a86b667126742cc17f4e31ae

# Install runtime dependencies
RUN apk upgrade --no-cache && apk add --no-cache tini

# Copy built application
COPY --from=builder /app/dist /usr/share/nginx/html/

# Copy configuration files
COPY --from=builder /app/docker/nginx.conf /etc/nginx/nginx.conf
COPY --from=builder /app/docker/entrypoint.sh /docker-entrypoint.sh

# Make entrypoint executable
RUN chmod +x /docker-entrypoint.sh


# Use tini to handle signals properly
ENTRYPOINT ["/sbin/tini", "--", "/docker-entrypoint.sh"]
