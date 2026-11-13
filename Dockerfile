# Optional. Der Hub läuft auch ohne Docker: npm install && npm start
FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
ENV HOST=0.0.0.0 PORT=8787 VERNETZUNG_DB=/data/vernetzung.sqlite
VOLUME /data
EXPOSE 8787
USER node
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.ts"]
