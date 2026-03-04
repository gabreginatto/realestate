FROM node:20-slim
WORKDIR /app

# Install dependencies
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy only what the review server needs
COPY scripts/review-server.js  scripts/review-server.js
COPY scripts/review-session.js scripts/review-session.js

ENV PORT=3001
ENV GCS_BUCKET=realestate-475615-data

EXPOSE 3001
CMD ["node", "scripts/review-server.js"]
