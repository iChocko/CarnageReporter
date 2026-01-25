# Build stage for Dashboard
FROM node:22-slim AS dashboard-build
WORKDIR /app/dashboard
COPY dashboard/package*.json ./
RUN npm install
COPY dashboard/ ./
RUN npm run build

# Final stage
FROM node:22-slim
WORKDIR /app

# Instalar dependencias para Puppeteer (Chromium) y utilidades
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libc6 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libexpat1 \
    libfontconfig1 \
    libgbm1 \
    libgcc1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libstdc++6 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    lsb-release \
    wget \
    xdg-utils \
    --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*

# Configurar Puppeteer para usar el Chromium instalado
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Copiar archivos del servidor
COPY server/package*.json ./server/
WORKDIR /app/server
RUN npm install --production

# Copiar el build del dashboard
COPY --from=dashboard-build /app/dashboard/dist /app/dashboard/dist
COPY server/ ./

# Exponer el puerto
EXPOSE 3000

# Comando para iniciar
CMD ["node", "index.js"]
