'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR, ensureDataDir } = require('./paths');

// ============== PREFERENCIAS (settings.json en DATA_DIR) ==============
// Hasta v1.6 vivía junto al exe; desde v1.7 vive en DATA_DIR (ver paths.js).
// main.js migra una copia del settings.json legado al primer arranque.

const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

function loadSettings(file = SETTINGS_FILE) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch {
        return {};
    }
}

function saveSettings(patch, file = SETTINGS_FILE) {
    const merged = { ...loadSettings(file), ...patch };
    try {
        ensureDataDir(path.dirname(file));
        fs.writeFileSync(file, JSON.stringify(merged, null, 2));
    } catch { /* preferencia no crítica: si no se pudo guardar, se reintenta la próxima vez */ }
    return merged;
}

/**
 * Identidad de esta instalación (Fase B3): un UUID generado una sola vez y
 * persistido en settings.json, mandado al servidor como X-Install-Id. Sirve
 * para poder revocar una instalación puntual (ej. reportes corruptos desde
 * una copia pirata/mal configurada) sin tocar la API key compartida.
 */
function ensureInstallId(file = SETTINGS_FILE) {
    const settings = loadSettings(file);
    if (settings.installId) return settings.installId;
    const installId = crypto.randomUUID();
    saveSettings({ installId }, file);
    return installId;
}

module.exports = { loadSettings, saveSettings, ensureInstallId, SETTINGS_FILE };
