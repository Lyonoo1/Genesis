FROM node:20-alpine AS base

# 直接使用淘宝/npmmirror 镜像源安装 pnpm，杜绝 corepack 向海外 registry.npmjs.org 下载龟速卡死
RUN npm install -g pnpm --registry=https://registry.npmmirror.com

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
WORKDIR /app

# 依赖层
FROM base AS deps
COPY package.json pnpm-lock.yaml ./
RUN pnpm config set registry https://registry.npmmirror.com && \
    pnpm config set strict-dep-builds false && \
    pnpm install --frozen-lockfile

# 构建层
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# 注入构建期环境变量
ENV NEXT_TELEMETRY_DISABLED=1
ARG NEXT_PUBLIC_API_BASE_URL="/genesis"
ENV NEXT_PUBLIC_API_BASE_URL=$NEXT_PUBLIC_API_BASE_URL
ARG NEXT_PUBLIC_BASE_PATH="/genesis"
ENV NEXT_PUBLIC_BASE_PATH=$NEXT_PUBLIC_BASE_PATH

RUN mkdir -p /app/public
RUN pnpm build

# 运行层
FROM base AS runner
ENV NODE_ENV=production
ENV PORT=3000

RUN mkdir -p ./public
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/next.config.mjs ./next.config.mjs

EXPOSE 3000

CMD ["pnpm", "start"]
