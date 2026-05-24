# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json pnpm-lock.yaml ./

RUN corepack enable && pnpm install --frozen-lockfile

COPY tsconfig.json ./tsconfig.json
COPY src ./src

RUN pnpm build

ENV NODE_ENV=production

CMD ["node", "dist/cli.js", "run-once"]

