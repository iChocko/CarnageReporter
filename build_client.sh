#!/bin/bash

# ============================================================
# CarnageReporter Client Build Script
# ============================================================

set -e

echo "╔══════════════════════════════════════════════════════════╗"
echo "║          BUILDING CARNAGE REPORTER CLIENT                ║"
echo "╚══════════════════════════════════════════════════════════╝"

# Ir al directorio del script
cd "$(dirname "$0")"

# 1. Instalar dependencias del cliente
echo "📦 Instalando dependencias en el directorio 'client'..."
cd client
npm install
cd ..

# 2. Crear directorio de distribución
mkdir -p dist

# 3. Generar el ejecutable usando pkg
echo "🔨 Compilando ejecutable para Windows (.exe)..."
# Usamos el script de construcción definido en el package.json de la raíz o lo ejecutamos directo
npx pkg client/carnage_client.js --targets node18-win-x64 --output dist/CarnageReporter.exe

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║             ✅ CONSTRUCCIÓN COMPLETADA                   ║"
echo "║  Archivo: dist/CarnageReporter.exe                       ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo "🚀 Ya puedes compartir el archivo .exe con tus amigos."
