# 1) Compila o React
FROM node:20-alpine AS web
WORKDIR /web
COPY web/package*.json ./
RUN npm ci
COPY web/ .
RUN npm run build

# 2) Roda a API servindo o React compilado
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY api/package*.json ./
RUN npm ci --omit=dev
COPY api/ .
COPY --from=web /web/dist ./public
EXPOSE 3000
CMD ["node", "src/server.js"]
