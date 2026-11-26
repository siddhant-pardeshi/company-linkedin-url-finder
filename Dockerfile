FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json tsconfig.api.json tsconfig.matching.json ./
COPY apps/api/package.json apps/api/package.json
COPY packages/matching/package.json packages/matching/package.json
COPY packages/test-fixtures/package.json packages/test-fixtures/package.json
COPY apps/extension/package.json apps/extension/package.json
RUN npm ci
COPY tools ./tools
COPY apps/api ./apps/api
COPY packages ./packages
RUN npm run build:api

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/dist/api ./dist/api
USER node
EXPOSE 8787
CMD ["node", "dist/api/server.js"]
