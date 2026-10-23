# 构建阶段：安装依赖并编译 TypeScript
FROM node:22-alpine AS build
WORKDIR /app

RUN npm install -g pnpm@12.14.0

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build && pnpm prune --prod

# 运行阶段：只带编译产物与生产依赖
FROM node:22-alpine
WORKDIR /app

ENV NODE_ENV=production \
    PORT=8000 \
    HOST=0.0.0.0

COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

EXPOSE 8000
USER node

CMD ["node", "dist/index.js"]
