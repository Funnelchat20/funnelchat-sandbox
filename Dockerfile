# funnelchat-sandbox en un contenedor: docker build -t funnelchat-sandbox . && docker run --rm -p 4010:4010 funnelchat-sandbox
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsup.config.ts ./
COPY src ./src
COPY generated ./generated
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
# 0.0.0.0 para que el puerto publicado llegue al proceso. Un archivo de configuración se monta en
# /app/funnelchat-sandbox.config.json (se lee solo) o se pasa con --config.
ENTRYPOINT ["node", "dist/cli.js", "--host", "0.0.0.0"]
