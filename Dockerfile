FROM ghcr.io/puppeteer/puppeteer:22.0.0

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies (skip puppeteer download, sudah ada di base image)
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable

RUN npm install --omit=dev

# Copy source code
COPY . .

# Jalankan bot
CMD ["node", "bot.js"]
