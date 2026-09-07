'use strict';

const fs = require('fs');
const path = require('path');
const { BASE_DIR } = require('./paths');

// ============== PREFERENCIAS (settings.json junto al exe) ==============

const SETTINGS_FILE = path.join(BASE_DIR, 'settings.json');

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
        fs.writeFileSync(file, JSON.stringify(merged, null, 2));
    } catch { /* preferencia no crítica: si no se pudo guardar, se reintenta la próxima vez */ }
    return merged;
}

module.exports = { loadSettings, saveSettings, SETTINGS_FILE };
