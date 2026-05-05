FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    DISPLAY=:99 \
    CAPTURE_SIZE=1280x720 \
    FPS=30 \
    VIDEO_BITRATE=2500k

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    chromium \
    dumb-init \
    ffmpeg \
    fluxbox \
    fonts-liberation \
    fonts-noto-color-emoji \
    novnc \
    websockify \
    x11vnc \
    xvfb \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 3001 5900 6080
ENTRYPOINT ["dumb-init", "--", "/entrypoint.sh"]

