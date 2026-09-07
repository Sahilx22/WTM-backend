# --- deps: full install (needs a build toolchain — bcrypt has native bindings) ---
FROM node:22-alpine AS deps
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json ./
RUN npm ci

# --- build: compile TypeScript (src/ + scripts/) to dist/ ---
FROM deps AS build
WORKDIR /app
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build

# --- prod-deps: a separate, production-only install (no devDependencies) ---
FROM node:22-alpine AS prod-deps
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# --- production: minimal runtime image, no build toolchain at all ---
FROM node:22-alpine AS production
WORKDIR /app
ENV NODE_ENV=production

COPY package.json ./
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

# Baileys session credentials + CSV-import staging live here — mount a
# volume at this path or every restart loses the linked WhatsApp session.
RUN mkdir -p data
VOLUME ["/app/data"]

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://localhost:'+(process.env.PORT||3000)+'/api/health', r => process.exit(r.statusCode===200?0:1)).on('error', () => process.exit(1))"

CMD ["node", "dist/src/server.js"]
