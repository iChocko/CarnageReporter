'use strict';

const path = require('path');

// ============== RUTAS BASE Y MODO ==============
// Empaquetado (pkg o SEA), TODO lo que el programa escribe (settings, log,
// updates) vive JUNTO AL EXE, nunca en el cwd: cuando Windows nos arranca
// solo (clave Run), el cwd es System32 y ahí no se puede escribir.

const IS_PKG = typeof process.pkg !== 'undefined';

// Detección de Node SEA (alternativa a pkg, ver docs/sea-fallback.md). Se
// deja preparada aunque hoy el build usa @yao-pkg/pkg: node:sea no existe
// en todas las versiones de Node, por eso el require va guardado.
function isPackaged() {
    if (IS_PKG) return true;
    try {
        const sea = require('node:sea');
        return !!(sea && typeof sea.isSea === 'function' && sea.isSea());
    } catch {
        return false;
    }
}

const BASE_DIR = IS_PKG ? path.dirname(process.execPath) : path.join(__dirname, '..');
const IS_BACKGROUND = process.argv.includes('--background');

module.exports = { IS_PKG, isPackaged, BASE_DIR, IS_BACKGROUND };
