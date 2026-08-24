FROM node:22-slim AS build

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-slim AS runtime

ENV NODE_ENV=production
ENV DATABASE_PATH=/app/data/data.json
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
RUN mkdir -p /app/data && chown node:node /app/data

VOLUME ["/app/data"]
USER node
CMD ["node", "dist/index.js"]
