FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
USER node
# Structured JSON logs + request ids (logging standard, AGENTS.md; logkit/README.md). No IPs or user agents.
COPY logkit ./logkit
ENV LOG_APP=tanzbar-studio LOG_IP=0 LOG_UA=0
CMD ["node", "-r", "./logkit/logkit-preload.cjs", "src/server.js"]