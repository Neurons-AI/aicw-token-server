FROM node:22-slim
WORKDIR /app
COPY package.json tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm install --no-audit --no-fund && npx tsc -p tsconfig.build.json && npm prune --omit=dev
WORKDIR /data
ENV PORT=8787
EXPOSE 8787
# Mount a folder with token-server.json at /data; the SQLite wallets live there too.
CMD ["node", "/app/dist/cli.js", "start"]
