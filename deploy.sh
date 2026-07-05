#!/bin/bash

# ============================================================
# CarnageReporter - Docker Deployment Script
# ============================================================
# Este VPS es infraestructura COMPARTIDA con otros proyectos:
#   - xochimilcovive.com corre nativo (PM2) en el puerto 3000
#   - Supabase self-hosted ocupa 3100/8000/8443/5432/6543
#   - Caddy (nativo, no Docker) es el único proxy reverso del VPS
# Por eso CarnageReporter usa un docker-compose PROPIO y AISLADO
# (no toca ningún compose ni contenedor de otros proyectos), y se
# expone en HOST_PORT (ver abajo) — Caddy enruta el dominio hacia
# ese puerto vía un bloque dedicado en /etc/caddy/Caddyfile.
#
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
#        HOST_PORT=3001     (opcional, default 3001 — puerto libre en el VPS)
#   4. Bloque de Caddy para el dominio ya configurado (ver
#      docs/caddy-h3mccstats.conf o la sección correspondiente
#      del Caddyfile del VPS) apuntando a reverse_proxy localhost:$HOST_PORT
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
HOST_PORT="${HOST_PORT:-3001}"

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
ssh -o StrictHostKeyChecking=accept-new "$SSH_TARGET" "HOST_PORT=$HOST_PORT bash -s" << 'ENDSSH'
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

# 2. Escribir el docker-compose PROPIO de este proyecto (aislado, sin
#    tocar ningún compose/Traefik global — este VPS no usa Traefik).
echo "🔧 Escribiendo docker-compose.yml del proyecto (puerto host: ${HOST_PORT})..."
cat > /root/carnage-reporter-docker/docker-compose.yml << EOF
services:
  carnage-dashboard:
    image: carnage-reporter:latest
    container_name: carnage-dashboard
    restart: always
    ports:
      - "127.0.0.1:${HOST_PORT}:3000"
    env_file:
      - /root/carnage-reporter-docker/.env
    volumes:
      - /root/carnage-reporter-docker/server/output:/app/server/output
      # Sesión de WhatsApp persistente (sobrevive redeploys; escanear QR solo una vez)
      - /root/carnage-reporter-docker/wwebjs_auth:/app/server/.wwebjs_auth
EOF

# 3. Levantar SOLO este servicio (no afecta nada más del VPS)
echo "🚀 Reiniciando contenedor..."
cd /root/carnage-reporter-docker
docker compose up -d

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║              ✅ DEPLOYMENT COMPLETADO                    ║"
echo "║      URL: https://h3mccstats.cloud                       ║"
echo "║      (verifica que Caddy ya tenga el bloque de este      ║"
echo "║       dominio apuntando a localhost:${HOST_PORT})              ║"
echo "╚══════════════════════════════════════════════════════════╝"
ENDSSH

# Limpiar local
rm -f /tmp/carnage-docker-deploy.tar.gz

echo ""
echo "✅ Proceso terminado."
