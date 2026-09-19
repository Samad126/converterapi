# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Build stage
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build \
 && npm prune --omit=dev

# ---------------------------------------------------------------------------
# Runtime stage
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

# LibreOffice headless is the conversion engine.
#
# The font packages are NOT optional and NOT cosmetic. Calibri and Cambria do
# not exist on Linux; without metric-compatible substitutes LibreOffice picks a
# font with different glyph widths, so every line breaks in a different place
# and the PDF paginates differently from Word - while converting successfully
# and looking perfectly correct. `fonts-liberation` does the same job for Arial,
# Times New Roman and Courier New.
#
# ttf-mscorefonts-installer is deliberately NOT used: it needs an interactive
# EULA acceptance, which breaks unattended image builds, and the metric-
# compatible set above is a drop-in replacement for the metrics that pagination
# actually depends on. See README "Fonts".
#
# The service refuses to boot without these (see preflight() in src/convert.ts),
# so a mistake here fails loudly at startup rather than silently in production.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      libreoffice-writer \
      fonts-crosextra-carlito \
      fonts-crosextra-caladea \
      fonts-liberation \
      fonts-opensymbol \
      fontconfig \
      ca-certificates \
 && fc-cache -f \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PORT=3001 \
    HOST=0.0.0.0 \
    TEMP_ROOT=/tmp/docx-to-pdf \
    HOME=/tmp

WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# The OpenAPI document is read at runtime (served at /openapi.json and /docs),
# not compiled, so it has to be copied across separately. src/openapi.ts
# resolves it as `../openapi.yaml`, which lands here from dist/.
COPY openapi.yaml ./

# Unprivileged. The service refuses to start as root, and the image already
# ships a `node` user (uid 1000) - so there is nothing to create.
USER node

EXPOSE 3001

# The start period covers preflight plus the warm-up conversion.
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server.js"]
