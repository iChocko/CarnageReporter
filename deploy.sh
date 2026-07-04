#!/bin/bash

# ============================================================
# CarnageReporter - Docker Deployment Script
# ============================================================
# Requisitos:
#   1. Acceso SSH por llave al VPS (sin password):
#        ssh root@<host> debe entrar directo.
#   2. Archivo de entorno EN EL VPS (una sola vez, nunca en git):
#        /root/carnage-reporter-docker/.env
#      con: PORT, SUPABASE_URL, SUPABASE_KEY, DISCORD_WEBHOOK_URL,
#           API_KEY, ADMIN_KEY, STRIPE_SECRET_KEY, etc. (ver .env.example)
#   3. Configuración local del deploy (variables de entorno o un
#      archivo .env.deploy junto a este script, gitignoreado):
#        DEPLOY_HOST=ip.o.dominio.del.vps
#        DEPLOY_USER=root   (opcional, default root)
# ============================================================

set -e

cd "$(dirname "$0")"

# Cargar configuración local del deploy si existe
if [ -f .env.deploy ]; then
    set -a
    # shellcheck disable=SC1091
    source .env.deploy
    set +a
fi

DEPLOY_USER="${DEPLOY_USER:-root}"

if [ -z "$DEPLOY_HOST" ]; then
    echo "❌ Falta DEPLOY_HOST."
    echo "   Define la variable de entorno o crea un archivo .env.deploy con:"
    echo "     DEPLOY_HOST=tu.vps.com"
    echo "     DEPLOY_USER=root"
    exit 1
fi

SSH_TARGET="$DEPLOY_USER@$DEPLOY_HOST"

echo "╔══════════════════════════════════════════════════════════╗"
echo "║        CARNAGE REPORTER - DOCKER DEPLOYMENT              ║"
echo "║             Target: h3mccstats.cloud                     ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""

echo "📦 Preparando archivos para deployment..."

# Empaquetar todo el repositorio para construirlo en el VPS
tar --exclude=.git --exclude=node_modules --exclude=dashboard/node_modules -czf /tmp/carnage-docker-deploy.tar.gz .

echo "🚀 Conectando a $SSH_TARGET..."

# FASE 1: Subir archivos (autenticación por llave SSH)
scp -o StrictHostKeyChecking=accept-new /tmp/carnage-docker-deploy.tar.gz "$SSH_TARGET:/tmp/"

# FASE 2: Desplegar en el VPS
ssh -o StrictHostKeyChecking=accept-new "$SSH_TARGET" << 'ENDSSH'
set -e
mkdir -p /root/carnage-reporter-docker
cd /root/carnage-reporter-docker

# Verificar que el archivo de entorno exista ANTES de tocar nada
if [ ! -f /root/carnage-reporter-docker/.env ]; then
    echo "❌ No existe /root/carnage-reporter-docker/.env en el VPS."
    echo "   Créalo una sola vez con las variables de producción (ver .env.example del repo)."
    exit 1
fi

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

# Crear el bloque del servicio (secretos vía env_file, nunca inline)
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
    env_file:
      - /root/carnage-reporter-docker/.env
    volumes:
      - /root/carnage-reporter-docker/server/output:/app/server/output
      # Sesión de WhatsApp persistente (sobrevive redeploys; escanear QR solo una vez)
      - /root/carnage-reporter-docker/wwebjs_auth:/app/server/.wwebjs_auth
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
echo "✅ Proceso terminado."
