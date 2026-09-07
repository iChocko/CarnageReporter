# Build stage for Dashboard
FROM node:22-slim AS dashboard-build
WORKDIR /app/dashboard
COPY dashboard/package*.json ./
RUN npm ci
COPY dashboard/ ./
ARG VITE_STRIPE_PUBLISHABLE_KEY
ENV VITE_STRIPE_PUBLISHABLE_KEY=$VITE_STRIPE_PUBLISHABLE_KEY
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
RUN npm ci --omit=dev

# Copiar el build del dashboard
COPY --from=dashboard-build /app/dashboard/dist /app/dashboard/dist
COPY server/ ./

# Exponer el puerto
EXPOSE 3000

# Healthcheck (Fase A1): pega a /api/health cada 30s. start-period de 90s le
# da tiempo a Puppeteer/WhatsApp-Web.js de terminar de inicializar antes de
# que un primer fallo cuente; nunca marca "unhealthy" por WhatsApp en
# waiting_qr (ver server/health.js) — solo por un Supabase caído.
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"

# Comando para iniciar
CMD ["node", "index.js"]
