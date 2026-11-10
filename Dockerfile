# Execução local/auto-hospedada via runtime workerd (Miniflare) — mesma base de código do deploy na Cloudflare.
FROM node:22-slim
WORKDIR /app
COPY package*.json .npmrc ./
RUN npm ci
COPY . .
RUN npm run build
ENV NODE_ENV=production
EXPOSE 8787
VOLUME /app/.wrangler/state
CMD ["sh", "-c", "npx wrangler d1 migrations apply nutrivida --local && npx wrangler dev --local --ip 0.0.0.0 --port 8787 --persist-to .wrangler/state"]
