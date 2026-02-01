#!/bin/bash

# ============================================================
# CARNAGE REPORTER - SCRIPT DE REMEDIACIÓN VPS
# ============================================================
# Soluciona: Node.js upgrade, Puppeteer+Snap, PM2, apt fixes
# Target: Ubuntu 24.04 LTS
# ============================================================

set -e

# Colores para output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log_info() { echo -e "${CYAN}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[OK]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║        CARNAGE REPORTER - REMEDIACIÓN VPS                ║"
echo "║              Ubuntu 24.04 + Node.js 22                   ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""

# ============================================================
# 1. CONFIGURACIÓN APT NO INTERACTIVA
# ============================================================
log_info "Configurando apt para modo no interactivo..."

export DEBIAN_FRONTEND=noninteractive
export NEEDRESTART_MODE=a
export NEEDRESTART_SUSPEND=1

# Evitar prompts de debconf
echo 'debconf debconf/frontend select Noninteractive' | debconf-set-selections 2>/dev/null || true

# Configurar apt para evitar bloqueos
APT_OPTS="-y -qq -o Dpkg::Options::='--force-confdef' -o Dpkg::Options::='--force-confold' -o APT::Get::Assume-Yes=true"

log_success "apt configurado en modo no interactivo"

# ============================================================
# 2. UPGRADE NODE.JS 18 → 22 LTS
# ============================================================
log_info "Actualizando Node.js a v22 LTS..."

# Detener PM2 primero
pm2 stop all 2>/dev/null || true
pm2 kill 2>/dev/null || true

# Eliminar Node.js 18 y repositorios antiguos
log_info "Eliminando Node.js 18 deprecated..."
apt-get remove $APT_OPTS nodejs npm 2>/dev/null || true
apt-get autoremove $APT_OPTS 2>/dev/null || true

# Limpiar repositorios de NodeSource antiguos
rm -f /etc/apt/sources.list.d/nodesource.list 2>/dev/null || true
rm -f /etc/apt/keyrings/nodesource.gpg 2>/dev/null || true
rm -f /usr/share/keyrings/nodesource.gpg 2>/dev/null || true

# Instalar dependencias necesarias
apt-get update $APT_OPTS
apt-get install $APT_OPTS ca-certificates curl gnupg

# Configurar repositorio NodeSource para Node.js 22
log_info "Configurando repositorio NodeSource para Node.js 22..."
mkdir -p /etc/apt/keyrings

curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | \
    gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg --yes

echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" | \
    tee /etc/apt/sources.list.d/nodesource.list > /dev/null

# Instalar Node.js 22
apt-get update $APT_OPTS
apt-get install $APT_OPTS nodejs

# Verificar versión
NODE_VERSION=$(node --version)
log_success "Node.js instalado: $NODE_VERSION"

# Reinstalar PM2 globalmente
log_info "Reinstalando PM2..."
npm install -g pm2@latest
PM2_VERSION=$(pm2 --version)
log_success "PM2 instalado: v$PM2_VERSION"

# ============================================================
# 3. CONFIGURACIÓN CHROMIUM SNAP PARA PUPPETEER
# ============================================================
log_info "Configurando Chromium Snap para Puppeteer..."

# Verificar si Chromium está instalado via Snap
if snap list chromium &>/dev/null; then
    CHROMIUM_PATH="/snap/bin/chromium"
    log_success "Chromium Snap detectado: $CHROMIUM_PATH"
else
    # Instalar Chromium via Snap si no existe
    log_info "Instalando Chromium via Snap..."
    snap install chromium
    CHROMIUM_PATH="/snap/bin/chromium"
fi

# Crear wrapper script para evitar problemas de AppArmor
log_info "Creando wrapper para Chromium..."
cat > /usr/local/bin/chromium-puppeteer << 'EOF'
#!/bin/bash
# Wrapper para Chromium Snap compatible con Puppeteer
exec /snap/bin/chromium \
    --no-sandbox \
    --disable-setuid-sandbox \
    --disable-dev-shm-usage \
    --disable-gpu \
    --no-first-run \
    --no-zygote \
    --single-process \
    "$@"
EOF
chmod +x /usr/local/bin/chromium-puppeteer

# Configurar variable de entorno para Puppeteer
echo "PUPPETEER_EXECUTABLE_PATH=/snap/bin/chromium" >> /etc/environment
echo "PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true" >> /etc/environment

log_success "Chromium configurado para Puppeteer"
echo ""
echo "   executablePath: '/snap/bin/chromium'"
echo "   Args necesarios:"
echo "     --no-sandbox"
echo "     --disable-setuid-sandbox"
echo "     --disable-dev-shm-usage"
echo "     --disable-gpu"
echo "     --no-first-run"
echo "     --no-zygote"
echo "     --single-process"
echo ""

# ============================================================
# 4. PERSISTENCIA PM2 CON SYSTEMD
# ============================================================
log_info "Configurando persistencia PM2 con systemd..."

# Detectar init system y configurar startup
PM2_STARTUP=$(pm2 startup systemd -u root --hp /root 2>&1)
log_info "Ejecutando: pm2 startup systemd -u root --hp /root"

# Habilitar el servicio
systemctl enable pm2-root 2>/dev/null || true

log_success "PM2 configurado para arranque automático con systemd"

# ============================================================
# 5. REINSTALAR DEPENDENCIAS DEL PROYECTO
# ============================================================
log_info "Reinstalando dependencias del proyecto..."

cd /root/carnage-reporter/server

# Limpiar node_modules y cache
rm -rf node_modules package-lock.json

# Instalar dependencias con audit fix
npm install --production 2>&1 | grep -v "deprecated"

# ============================================================
# 6. FIX VULNERABILIDADES NPM
# ============================================================
log_info "Ejecutando npm audit fix para vulnerabilidades..."

# Audit fix automático (no rompe dependencias)
npm audit fix 2>/dev/null || true

# Para vulnerabilidades más agresivas (puede romper compatibilidad)
# npm audit fix --force 2>/dev/null || true

# Actualizar dependencias deprecated específicas
log_info "Actualizando dependencias deprecated (glob, rimraf, inflight)..."
npm update glob rimraf 2>/dev/null || true

# Mostrar estado final de auditoría
echo ""
npm audit --audit-level=high 2>/dev/null || log_warn "Algunas vulnerabilidades no se pudieron resolver automáticamente"

log_success "Dependencias actualizadas"

# ============================================================
# 7. REINICIAR SERVICIOS
# ============================================================
log_info "Reiniciando servicios..."

cd /root/carnage-reporter/server

# Iniciar con PM2
pm2 start ecosystem.config.js

# Guardar estado de PM2 para persistencia
pm2 save

log_success "Servicios reiniciados"

# ============================================================
# 8. VERIFICACIÓN FINAL
# ============================================================
echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║              VERIFICACIÓN FINAL                          ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""

echo "Node.js:  $(node --version)"
echo "npm:      $(npm --version)"
echo "PM2:      $(pm2 --version)"
echo "Chromium: $(/snap/bin/chromium --version 2>/dev/null || echo 'N/A')"
echo ""

pm2 status

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║              ✅ REMEDIACIÓN COMPLETADA                   ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""
echo "Próximos pasos:"
echo "  1. Verificar logs:        pm2 logs carnage-server"
echo "  2. Probar API:            curl http://localhost:3000/api/health"
echo ""
echo "Si hay kernel pendiente de reinicio:"
echo "  reboot"
echo ""
