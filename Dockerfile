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

# Production dependencies first, so this layer is cached independently of the
# application code below and only re-runs when the manifests change.
#
# This is a normal production install now that `ws` has been moved from
# devDependencies to dependencies, where it belonged - the server imports it at
# runtime. It used to be a hand-targeted `COPY node_modules/ws`, which worked
# but silently relied on `ws` having no transitive dependencies of its own; a
# second runtime dependency would have produced a container that built cleanly
# and died on its first import. `npm ci --omit=dev` has no such failure mode.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# The server is not bundled or transpiled: Node 24 strips the TypeScript types
# at load time and runs the .ts files directly. So we ship the source.
COPY --from=build /app/server ./server
COPY --from=build /app/dist ./dist

# Don't run as root.
USER node

# The host (Fly/Render/Railway) injects PORT. Defaulting it keeps `docker run`
# usable locally without extra flags.
ENV PORT=8080
ENV OTRIO_STATIC_DIR=/app/dist
EXPOSE 8080

CMD ["node", "server/src/index.ts"]
