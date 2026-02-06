FROM node:20-slim

WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Copy application files
COPY matching-server.js ./
COPY public ./public
COPY data ./data

# Cloud Run uses PORT env var
ENV PORT=8080
ENV HOST=0.0.0.0

EXPOSE 8080

CMD ["node", "matching-server.js"]
