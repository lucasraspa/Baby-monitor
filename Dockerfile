FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY index.js server.js ./
COPY lib ./lib
COPY public ./public
USER node
EXPOSE 8830
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8830/healthz || exit 1
CMD ["node", "index.js"]
