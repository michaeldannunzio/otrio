# syntax=docker/dockerfile:1
#
# One container that serves BOTH the static frontend and the WebSocket host.
#
# That is deliberate, and it is the single most important decision in this
# file. One container means one origin, which means:
#   - one TLS certificate, issued and renewed by the host, so every phone gets
#     a real https:// URL and therefore a secure context - which is what
#     WebRTC, and several other mobile APIs, refuse to work without;
#   - no CORS configuration, and no ws:// -> wss:// mixed-content errors;
#   - no "which of these two URLs do I read out to my friends" problem.
#
# The alternative - static on a CDN, WebSocket on a separate service - works,
# but it costs you two hostnames and a CORS policy for no benefit at this size.

# ---------------------------------------------------------------- build ----
FROM node:24-alpine AS build
WORKDIR /app

# Copy manifests first so the dependency layer is cached independently of
# source changes. Only a package.json/lock edit re-runs the install.
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY . .

# Typecheck is part of `npm run build` (tsc -b && vite build), so a type error
# fails the image build rather than shipping a broken bundle.
RUN npm run build

# -------------------------------------------------------------- runtime ----
FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# The server is not bundled or transpiled: Node 24 strips the TypeScript types
# at load time and runs the .ts files directly. So we ship the source.
COPY --from=build /app/server ./server
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json

# `ws` is the server's only runtime dependency, and it has zero dependencies of
# its own (196K). Copying the exact tree the lockfile produced is smaller and
# more reproducible than a second `npm ci` in this stage.
#
# NOTE: `ws` currently sits in devDependencies in package.json, which is why
# this is a targeted copy rather than `npm ci --omit=dev`. If `ws` moves to
# `dependencies` - and it should - this can become a normal production install.
# If the server ever gains another runtime dependency, add it here too or the
# container will start and then die on its first import.
COPY --from=build /app/node_modules/ws ./node_modules/ws

# Don't run as root.
USER node

# The host (Fly/Render/Railway) injects PORT. Defaulting it keeps `docker run`
# usable locally without extra flags.
ENV PORT=8080
ENV OTRIO_STATIC_DIR=/app/dist
EXPOSE 8080

CMD ["node", "server/src/index.ts"]
