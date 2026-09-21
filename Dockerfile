FROM node:20-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY src ./src
# База, файли звітів і резервні копії живуть у /data (у Railway підключіть Volume на /data)
ENV DATA_DIR=/data
VOLUME ["/data"]
CMD ["node", "src/index.js"]
