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

# 2. Generar el ejecutable usando @yao-pkg/pkg (fork mantenido de pkg, node22)
echo "🔨 Compilando ejecutable para Windows (.exe)..."
npm run build
cd ..

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║             ✅ CONSTRUCCIÓN COMPLETADA                   ║"
echo "║  Archivo: client/dist/CarnageReporter.exe                ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo "🚀 Ya puedes compartir el archivo .exe con tus amigos."
