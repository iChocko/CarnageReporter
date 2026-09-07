'use strict';

const fs = require('fs');
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

// ============== DATA_DIR (Fase B3) ==============
// A partir de v1.7, settings/log/spool/status ya NO viven junto al exe sino
// en %LOCALAPPDATA%\CarnageReporter: BASE_DIR puede ser de solo lectura
// (Program Files, una carpeta compartida) o vivir en un volumen sincronizado
// (OneDrive) que no conviene llenar de archivos que cambian todo el tiempo.
// CARNAGE_DATA_DIR permite overridearlo en pruebas/desarrollo; sin
// LOCALAPPDATA (no debería pasar en Windows real) cae de vuelta a BASE_DIR.
const DATA_DIR = process.env.CARNAGE_DATA_DIR
    || (process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'CarnageReporter') : BASE_DIR);

function ensureDataDir(dataDir = DATA_DIR) {
    try {
        fs.mkdirSync(dataDir, { recursive: true });
    } catch { /* ya existe, o no se pudo: los callers manejan el error al escribir */ }
    return dataDir;
}

/**
 * Migración única de un archivo que en versiones <1.7 vivía junto al exe
 * (BASE_DIR) hacia DATA_DIR. Es una COPIA, no un movimiento: el archivo
 * viejo se deja donde está a propósito (ej. carnage_autostart.vbs, al que
 * el Run key de Windows ya apunta, sigue funcionando aunque esta migración
 * falle o no corra). Si DATA_DIR y BASE_DIR son la misma carpeta (fallback
 * sin LOCALAPPDATA) no hay nada que migrar.
 */
function migrateLegacyFile(filename, baseDir = BASE_DIR, dataDir = DATA_DIR) {
    if (path.resolve(baseDir) === path.resolve(dataDir)) return false;
    const legacyPath = path.join(baseDir, filename);
    const newPath = path.join(dataDir, filename);
    try {
        if (fs.existsSync(newPath)) return false;
        if (!fs.existsSync(legacyPath)) return false;
        ensureDataDir(dataDir);
        fs.copyFileSync(legacyPath, newPath);
        return true;
    } catch {
        return false; // migración best-effort: nunca debe tronar el arranque
    }
}

module.exports = {
    IS_PKG, isPackaged, BASE_DIR, IS_BACKGROUND, DATA_DIR, ensureDataDir, migrateLegacyFile
};
