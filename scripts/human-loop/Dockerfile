FROM node:20-slim

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy server and public files
COPY matching-server.js ./
COPY ../../public ./public

# Create data directory (will be mounted or populated)
RUN mkdir -p /app/data /app/data/mosaics/viva /app/data/mosaics/coelho

# Environment variables
ENV PORT=8080
ENV HOST=0.0.0.0
ENV DATA_ROOT=/app/data

EXPOSE 8080

CMD ["node", "matching-server.js"]
