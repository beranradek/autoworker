# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS builder

WORKDIR /app

COPY package.json pnpm-lock.yaml ./

RUN corepack enable && pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src

RUN pnpm build

FROM node:22-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production

COPY package.json pnpm-lock.yaml ./

RUN corepack enable && pnpm install --frozen-lockfile --prod

COPY --from=builder /app/dist ./dist

CMD ["node", "dist/cli.js", "run-once"]
