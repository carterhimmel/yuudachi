FROM --platform=linux/amd64 node:18-slim AS pruner
ENV NODE_ENV=production

# Set working directory
WORKDIR /app
RUN yarn global add turbo
COPY . .
RUN turbo prune --scope=yuudachi --docker

FROM --platform=linux/amd64 node:18-slim as builder
ENV NODE_ENV=production
RUN apt update
RUN apt install -y python3 g++ make libtool autoconf automake curl

WORKDIR /app
 
COPY --from=pruner /app/out/json/ .
COPY --from=pruner /app/out/yarn.lock ./yarn.lock
COPY .yarn .yarn
COPY .yarnrc.yml .
RUN yarn install --inline-builds
 
# Build the project
COPY --from=pruner /app/out/full/ .
COPY turbo.json turbo.json
RUN yarn turbo run build --filter=yuudachi

RUN yarn cache clean

CMD ["node", "--enable-source-maps",  "apps/yuudachi/dist/index.js"]
