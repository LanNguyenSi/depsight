# ── Stage 1: Dependencies ────────────────────────────────────────────
FROM node:20-slim AS deps

RUN apt-get update && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
COPY prisma ./prisma/
RUN npm ci
RUN npx prisma generate

# ── Stage 2: Build ───────────────────────────────────────────────────
FROM node:20-slim AS builder

RUN apt-get update && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ── Schema step (one-shot, target `migrate`) ─────────────────────────
# The Prisma CLI is the one package-lock.json pins and nothing else of the install: the
# `migrate-cli` stage takes the CLI and the packages it needs to run (its dependency closure,
# resolved the way Node resolves them) out of the deps stage's `npm ci` tree, engines included.
# The image therefore carries no dev dependencies and no app packages, and the CLI version is the
# lockfile's by construction (no second install that could re-resolve it). openssl is installed
# here at build time, so running the step fetches nothing and needs no outbound network. The
# schema and the pre-push SQL are copied from the same checkout the image is built from, so CLI,
# schema and SQL always match the app image of the same deploy. Used by the `migrate` service in
# docker-compose.traefik.yml; the final `runner` stage must stay last (it is the default target
# of the app image).
FROM deps AS migrate-cli

# Walks the dependency edges of `prisma` (dependencies and optionalDependencies; an optional
# package that is not installed is skipped, any other missing one fails the build) through the
# installed tree and copies each package directory, with its own nested node_modules, to /out.
RUN <<'EOF'
set -eu
node - /app > /tmp/prisma-cli.list <<'JS'
const fs = require("fs");
const path = require("path");
const root = process.argv[2];
const find = (name, from) => {
  for (let dir = from; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, "node_modules", name);
    if (fs.existsSync(path.join(candidate, "package.json"))) return candidate;
    if (path.dirname(dir) === dir) return null;
  }
};
const start = find("prisma", root);
if (!start) throw new Error("prisma is not installed");
const seen = new Set();
const todo = [start];
while (todo.length) {
  const dir = todo.pop();
  if (seen.has(dir)) continue;
  seen.add(dir);
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  const optional = pkg.optionalDependencies || {};
  for (const name of Object.keys({ ...optional, ...pkg.dependencies })) {
    const found = find(name, dir);
    if (found) todo.push(found);
    else if (!(name in optional)) throw new Error(`${pkg.name} needs ${name}, which is not installed`);
  }
}
for (const dir of [...seen].sort()) console.log(path.relative(root, dir));
JS
mkdir -p /out/node_modules/.bin
cd /app
xargs -a /tmp/prisma-cli.list cp -a --parents -t /out
ln -s ../prisma/build/index.js /out/node_modules/.bin/prisma
# Source maps, type declarations and the TypeScript sources of `effect` are never loaded when the
# CLI runs (about 40 MB).
find /out/node_modules -type f \( -name '*.map' -o -name '*.d.ts' -o -name '*.d.mts' -o -name '*.d.cts' \) -delete
rm -rf /out/node_modules/effect/src
EOF

FROM node:20-slim AS migrate

RUN apt-get update && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production
ENV PATH="/app/node_modules/.bin:${PATH}"
COPY --from=migrate-cli /out/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY prisma ./prisma/
# Fails at image build time, before the schema step touches the database, when
# the CLI cannot start from the pruned tree.
RUN CHECKPOINT_DISABLE=1 prisma --version

USER node

# ── Stage 3: Production ─────────────────────────────────────────────
FROM node:20-slim AS runner

RUN apt-get update && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder /app/prisma ./prisma
COPY --from=deps /app/node_modules/.prisma ./node_modules/.prisma

USER nextjs
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

CMD ["node", "server.js"]
