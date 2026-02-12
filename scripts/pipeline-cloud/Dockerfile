FROM node:20-slim

# Install system dependencies for Playwright, Python, and Sharp
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv \
    rsync \
    libvips-dev \
    libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
    libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
    libgbm1 libpango-1.0-0 libcairo2 libasound2 libatspi2.0-0 \
    libwayland-client0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Node.js dependencies (playwright, sharp, @google-cloud/storage, etc.)
COPY scripts/pipeline-cloud/package.json ./package.json
RUN npm install --omit=dev

# Install Playwright Chromium browser
RUN npx playwright install chromium

# Create Python virtual env and install Python dependencies
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"
RUN pip install --no-cache-dir \
    fastdup \
    opencv-python-headless \
    rich \
    typer \
    pandas \
    numpy

# Copy all scripts and config
COPY scripts/ ./scripts/
COPY config/ ./config/

# Create data directories (compound-scoped dirs are created at runtime by the pipeline)
RUN mkdir -p data work_fastdup selected_exteriors server-deploy/data

# Copy the entrypoint
COPY scripts/pipeline-cloud/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# Environment
ENV HEADLESS=true
ENV FORCE_FULL=true
ENV GCS_BUCKET=realestate-images-475615
ENV NODE_ENV=production

ENTRYPOINT ["/app/entrypoint.sh"]
