FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
USER node
CMD ["node", "src/server.js"]
