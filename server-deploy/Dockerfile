FROM node:20-slim

WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Copy application files
COPY matching-server.js ./
COPY gcs-data-sync.js ./
COPY compounds.json ./
COPY public ./public

# Data directories per compound — populated from GCS at runtime
RUN node -e "const c=require('./compounds.json'); Object.keys(c.compounds).forEach(id => { \
  const fs=require('fs'); \
  fs.mkdirSync('data/'+id+'/mosaics/viva', {recursive:true}); \
  fs.mkdirSync('data/'+id+'/mosaics/coelho', {recursive:true}); \
  fs.mkdirSync('data/'+id+'/listings', {recursive:true}); \
})"

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
