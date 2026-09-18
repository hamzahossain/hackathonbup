# syntax=docker/dockerfile:1.7
# ----------------------------------------------------------------------
# GridWise LLM — production container image for the BUP CSE Fest 2026
# preliminary. Multi-stage build keeps the runtime image small and
# free of the TypeScript toolchain.
#
# Required at runtime (passed via --env-file, NEVER baked in):
#   GEMINI_API_KEY
#   GEMINI_MODEL      (optional, defaults to gemini-3.5-flash-lite)
#   PORT              (optional, defaults to 8000)
#
# Bind:  0.0.0.0:8000 (the judge harness hits this from outside)
# Ready: GET /health returns {"status":"ok"} within 60s of `docker run`
# ----------------------------------------------------------------------

# ---------- Stage 1: build ----------
FROM node:20-alpine AS build
WORKDIR /app

# Install all deps (including dev) so tsc + types are available
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

# Bring in source + tsconfig and compile to dist/
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Prune devDependencies so the runtime image only carries production deps
RUN npm prune --omit=dev


# ---------- Stage 2: runtime ----------
FROM node:20-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=8000

# Run as a non-root user for better hygiene
RUN addgroup -S gridwise && adduser -S gridwise -G gridwise

# Copy only what we need from the build stage
COPY --from=build --chown=gridwise:gridwise /app/package.json ./package.json
COPY --from=build --chown=gridwise:gridwise /app/node_modules ./node_modules
COPY --from=build --chown=gridwise:gridwise /app/dist ./dist

USER gridwise

EXPOSE 8000

# Quick container-side sanity probe using the same Node binary that runs the service
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD wget -qO- http://127.0.0.1:${PORT}/health || exit 1

CMD ["node", "dist/index.js"]
