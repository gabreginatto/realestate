FROM node:20-slim

WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Copy application files
COPY matching-server.js ./
COPY gcs-data-sync.js ./
COPY public ./public

# Data directory created empty — populated from GCS at runtime
RUN mkdir -p data/mosaics/viva data/mosaics/coelho data/listings

# Cloud Run uses PORT env var
ENV PORT=8080
ENV HOST=0.0.0.0
ENV GCS_BUCKET=realestate-images-475615
ENV REPORT_EMAIL=dominique.gerbauld@gmail.com
ENV SMTP_HOST=smtp.gmail.com
ENV SMTP_PORT=587
ENV SMTP_USER=gabrielpreginatto@gmail.com

EXPOSE 8080

CMD ["node", "matching-server.js"]
