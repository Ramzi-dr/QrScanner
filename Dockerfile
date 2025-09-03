# syntax=docker/dockerfile:1
FROM --platform=$BUILDPLATFORM node:22-slim AS base

# Install curl (Debian/Ubuntu based, works on both amd64 + arm64)
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files first for caching
COPY package*.json ./

# Install deps (no dev deps in production)
RUN npm install --omit=dev

# Copy the rest of the app
COPY . .

# Run your server (Express QR scanner)
CMD ["node", "index.js"]
