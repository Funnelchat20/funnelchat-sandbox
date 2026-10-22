# funnelchat-sandbox in a container: docker build -t funnelchat-sandbox . && docker run --rm -p 4010:4010 funnelchat-sandbox
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsup.config.ts ./
COPY src ./src
COPY generated ./generated
COPY spec/catalog.json ./spec/catalog.json
RUN npm run build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY spec/procedencia.json ./spec/procedencia.json
USER node
EXPOSE 4010
# 0.0.0.0 so the published port reaches the process. A configuration file is mounted at
# /app/funnelchat-sandbox.config.json (read on its own) or passed with --config.
ENTRYPOINT ["node", "dist/cli.js", "--host", "0.0.0.0"]
