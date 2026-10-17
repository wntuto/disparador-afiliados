FROM node:22.22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
# O banco SQLite fica em /data; no Railway, monte um Volume nesse caminho.
ENV DB_PATH=/data/disparador.db
EXPOSE 3000
CMD ["node", "--no-warnings=ExperimentalWarning", "src/server.ts"]
