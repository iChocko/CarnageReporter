#!/bin/bash

# ============================================================
# CarnageReporter - Script de Deployment para VPS
# ============================================================
# Uso: ./deploy.sh
# Target: Ubuntu 24.04 LTS + Node.js 22 LTS
# Requisitos: sshpass instalado (apt install sshpass)
# ============================================================

set -e

# Configuración del servidor
SERVER_IP="31.97.209.182"
SERVER_USER="root"
SERVER_PASS="1Chockownz(@)"
REMOTE_DIR="/root/carnage-reporter"

echo "╔══════════════════════════════════════════════════════════╗"
echo "║        CARNAGE REPORTER - DEPLOYMENT SCRIPT              ║"
echo "║              Ubuntu 24.04 + Node.js 22 LTS               ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""

# Verificar sshpass
if ! command -v sshpass &> /dev/null; then
    echo "❌ sshpass no está instalado."
    echo "   Instalar con: sudo apt install sshpass"
    exit 1
fi

echo "📦 Preparando archivos para deployment..."

# Crear archivo tar con los archivos del servidor
cd "$(dirname "$0")"
tar -czf /tmp/carnage-server.tar.gz server/

echo "🚀 Conectando al servidor $SERVER_IP..."

# Ejecutar comandos en el servidor - FASE 1: Dependencias del sistema
sshpass -p "$SERVER_PASS" ssh -o StrictHostKeyChecking=no "$SERVER_USER@$SERVER_IP" << 'ENDSSH'
echo "📁 Preparando directorios..."
mkdir -p /root/carnage-reporter/logs
mkdir -p /root/carnage-reporter/server/output

# ============================================================
# CONFIGURACIÓN APT NO INTERACTIVA (FIX DEBCONF/TTY)
# ============================================================
export DEBIAN_FRONTEND=noninteractive
export NEEDRESTART_MODE=a
export NEEDRESTART_SUSPEND=1

# Flags de apt para evitar bloqueos
APT_OPTS="-y -qq -o Dpkg::Options::='--force-confdef' -o Dpkg::Options::='--force-confold'"

# Evitar prompts de debconf
echo 'debconf debconf/frontend select Noninteractive' | debconf-set-selections 2>/dev/null || true

# ============================================================
# INSTALACIÓN NODE.JS 22 LTS
# ============================================================
CURRENT_NODE=$(node --version 2>/dev/null || echo "none")
echo "📦 Node.js actual: $CURRENT_NODE"

if [[ "$CURRENT_NODE" != v22* ]]; then
    echo "📥 Instalando Node.js 22 LTS..."

    # Limpiar instalaciones anteriores
    apt-get remove $APT_OPTS nodejs npm 2>/dev/null || true
    rm -f /etc/apt/sources.list.d/nodesource.list 2>/dev/null || true
    rm -f /etc/apt/keyrings/nodesource.gpg 2>/dev/null || true

    # Instalar dependencias
    apt-get update $APT_OPTS
    apt-get install $APT_OPTS ca-certificates curl gnupg

    # Configurar repositorio NodeSource
    mkdir -p /etc/apt/keyrings
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | \
        gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg --yes

    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" | \
        tee /etc/apt/sources.list.d/nodesource.list > /dev/null

    apt-get update $APT_OPTS
    apt-get install $APT_OPTS nodejs

    echo "✅ Node.js $(node --version) instalado"
fi

# ============================================================
# INSTALACIÓN PM2
# ============================================================
if ! command -v pm2 &> /dev/null; then
    echo "📥 Instalando PM2..."
    npm install -g pm2@latest
fi

# ============================================================
# INSTALACIÓN CHROMIUM VIA SNAP (UBUNTU 24.04)
# ============================================================
if ! snap list chromium &>/dev/null; then
    echo "📥 Instalando Chromium via Snap..."
    snap install chromium
fi

# Configurar variables de entorno para Puppeteer
grep -q "PUPPETEER_EXECUTABLE_PATH" /etc/environment || \
    echo "PUPPETEER_EXECUTABLE_PATH=/snap/bin/chromium" >> /etc/environment
grep -q "PUPPETEER_SKIP_CHROMIUM_DOWNLOAD" /etc/environment || \
    echo "PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true" >> /etc/environment

echo "✅ Dependencias del sistema instaladas"
echo "   Node.js: $(node --version)"
echo "   npm:     $(npm --version)"
echo "   PM2:     $(pm2 --version)"
echo "   Chromium: $(/snap/bin/chromium --version 2>/dev/null | head -1)"
ENDSSH

echo "📤 Subiendo archivos al servidor..."
sshpass -p "$SERVER_PASS" scp -o StrictHostKeyChecking=no /tmp/carnage-server.tar.gz "$SERVER_USER@$SERVER_IP:/tmp/"

echo "📦 Extrayendo y configurando..."
sshpass -p "$SERVER_PASS" ssh -o StrictHostKeyChecking=no "$SERVER_USER@$SERVER_IP" << 'ENDSSH'
cd /root/carnage-reporter

# Detener el servicio actual si existe
pm2 stop carnage-server 2>/dev/null || true
pm2 delete carnage-server 2>/dev/null || true

# Extraer archivos nuevos
tar -xzf /tmp/carnage-server.tar.gz
rm /tmp/carnage-server.tar.gz

# Instalar dependencias
cd server

# Limpiar cache para evitar problemas con cambio de Node version
rm -rf node_modules package-lock.json 2>/dev/null || true

# Instalar con supresión de warnings de deprecación
npm install --production 2>&1 | grep -v "deprecated" || true

# ============================================================
# FIX VULNERABILIDADES NPM
# ============================================================
echo "🔒 Ejecutando npm audit fix..."
npm audit fix 2>/dev/null || true
npm update glob rimraf 2>/dev/null || true

# ============================================================
# CONFIGURAR PUPPETEER PARA SNAP CHROMIUM
# ============================================================
export PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
export PUPPETEER_EXECUTABLE_PATH=/snap/bin/chromium

# ============================================================
# INICIAR CON PM2
# ============================================================
pm2 start ecosystem.config.js

# ============================================================
# PERSISTENCIA PM2 CON SYSTEMD
# ============================================================
echo "🔧 Configurando persistencia PM2..."
pm2 save

# Generar script de startup para systemd
pm2 startup systemd -u root --hp /root 2>/dev/null || true
systemctl enable pm2-root 2>/dev/null || true

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║              ✅ DEPLOYMENT COMPLETADO                    ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""
pm2 status
echo ""
echo "📱 Para ver el QR de WhatsApp:"
echo "   pm2 logs carnage-server"
echo ""
echo "🌐 API disponible en:"
echo "   http://31.97.209.182:3000/api/health"
echo ""
echo "⚠️  Si hay kernel pendiente de reinicio, ejecutar: reboot"
ENDSSH

# Limpiar archivo temporal
rm /tmp/carnage-server.tar.gz

echo ""
echo "✅ Deployment completado!"
echo ""
echo "Comandos útiles:"
echo "  Ver logs:      ssh root@$SERVER_IP 'pm2 logs carnage-server'"
echo "  Reiniciar:     ssh root@$SERVER_IP 'pm2 restart carnage-server'"
echo "  Status:        ssh root@$SERVER_IP 'pm2 status'"
echo "  Remediar:      ssh root@$SERVER_IP 'bash /root/carnage-reporter/server/remediate.sh'"
