#!/bin/bash

# ============================================================
# CarnageReporter - Docker Deployment Script
# ============================================================

set -e

# Configuración del servidor
SERVER_IP="31.97.209.182"
SERVER_USER="root"
SERVER_PASS="1Chockownz(@)"

echo "╔══════════════════════════════════════════════════════════╗"
echo "║        CARNAGE REPORTER - DOCKER DEPLOYMENT              ║"
echo "║             Target: h3mccstats.cloud                     ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""

# Verificar sshpass
if ! command -v sshpass &> /dev/null; then
    echo "❌ sshpass no está instalado. Instalar con: sudo apt install sshpass"
    exit 1
fi

echo "📦 Preparando archivos para deployment..."

# Empaquetar todo el repositorio para construirlo en el VPS
cd "$(dirname "$0")"
tar --exclude=.git --exclude=node_modules --exclude=dashboard/node_modules -czf /tmp/carnage-docker-deploy.tar.gz .

echo "🚀 Conectando al servidor $SERVER_IP..."

# FASE 1: Subir archivos
sshpass -p "$SERVER_PASS" scp -o StrictHostKeyChecking=no /tmp/carnage-docker-deploy.tar.gz "$SERVER_USER@$SERVER_IP:/tmp/"

# FASE 2: Desplegar en el VPS
sshpass -p "$SERVER_PASS" ssh -o StrictHostKeyChecking=no "$SERVER_USER@$SERVER_IP" << 'ENDSSH'
set -e
mkdir -p /root/carnage-reporter-docker
cd /root/carnage-reporter-docker

# Extraer archivos
echo "📦 Extrayendo archivos..."
tar -xzf /tmp/carnage-docker-deploy.tar.gz
rm /tmp/carnage-docker-deploy.tar.gz

# 1. Construir la imagen Docker
echo "🏗️  Construyendo imagen Docker..."
docker build -t carnage-reporter:latest .

# 2. Reconstruir docker-compose.yml
echo "🔧 Configurando docker-compose.yml..."

# Empezamos desde el backup original para evitar duplicados
if [ -f /root/docker-compose.yml.bak ]; then
    cp /root/docker-compose.yml.bak /root/docker-compose.yml
else
    cp /root/docker-compose.yml /root/docker-compose.yml.bak
fi

# Crear el bloque del servicio
cat > /tmp/carnage-service.yml << 'EOF'
  carnage-dashboard:
    image: carnage-reporter:latest
    restart: always
    labels:
      - traefik.enable=true
      - traefik.http.routers.h3mcc.rule=Host(`h3mccstats.cloud`) || Host(`www.h3mccstats.cloud`)
      - traefik.http.routers.h3mcc.tls=true
      - traefik.http.routers.h3mcc.entrypoints=web,websecure
      - traefik.http.routers.h3mcc.tls.certresolver=mytlschallenge
    volumes:
      - /root/carnage-reporter-docker/server/output:/app/server/output
    environment:
      - PORT=3000
      - SUPABASE_URL=https://isxjfvrdnmrwxyzfbvua.supabase.co
      - SUPABASE_KEY=sb_secret_bgUkXG9EjVga3lIy8k-StA_W_I6VDGa
EOF

# Dividir el archivo y reconstruirlo
# Tomamos todo antes de 'volumes:'
sed -n '1,/^volumes:/p' /root/docker-compose.yml | head -n -1 > /root/docker-compose.new.yml
# Añadimos el servicio
cat /tmp/carnage-service.yml >> /root/docker-compose.new.yml
echo "" >> /root/docker-compose.new.yml
# Añadimos el resto del archivo original
sed -n '/^volumes:/,$p' /root/docker-compose.yml >> /root/docker-compose.new.yml

mv /root/docker-compose.new.yml /root/docker-compose.yml

# 3. Reiniciar el stack con docker compose
echo "🚀 Reiniciando stack..."
cd /root
docker compose up -d

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║              ✅ DEPLOYMENT COMPLETADO                    ║"
echo "║      URL: https://h3mccstats.cloud                       ║"
echo "╚══════════════════════════════════════════════════════════╝"
ENDSSH

# Limpiar local
rm -f /tmp/carnage-docker-deploy.tar.gz

echo ""
echo "✅ Proceso terminado. Verifica DNS en Hostinger."
