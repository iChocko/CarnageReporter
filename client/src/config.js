'use strict';

const fs = require('fs');
const path = require('path');
const { loadSettings } = require('./settings');

// ============== RESOLUCIÓN DE CONFIGURACIÓN ==============
// Prioridad (de menor a mayor):
//   config.gen.js (build) < config.json (junto al exe) < settings.json
//   (serverUrl, editable desde el menú/archivo en DATA_DIR) < variables de entorno

const DEFAULT_SERVER_URL = 'https://h3mccstats.cloud';

function resolveConfig(env = process.env, execPath = process.execPath, cwd = process.cwd(), settings = null) {
    const config = { serverUrl: DEFAULT_SERVER_URL, apiKey: null };

    // 1. config.gen.js: generado por el CI al compilar el .exe (no existe en el repo)
    try {
        const gen = require('../config.gen.js');
        if (gen.apiKey) config.apiKey = gen.apiKey;
        if (gen.serverUrl) config.serverUrl = gen.serverUrl;
    } catch { /* no existe config.gen.js en desarrollo (solo lo genera el CI) */ }

    // 2. config.json junto al ejecutable (o al cwd en modo desarrollo):
    //    permite rotar la key o apuntar a otro servidor sin recompilar
    const candidates = [
        path.join(path.dirname(execPath), 'config.json'),
        path.join(cwd, 'config.json')
    ];
    for (const cfgPath of candidates) {
        try {
            if (fs.existsSync(cfgPath)) {
                const userCfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
                if (userCfg.apiKey) config.apiKey = userCfg.apiKey;
                if (userCfg.serverUrl) config.serverUrl = userCfg.serverUrl;
                console.log(`⚙️  Configuración cargada desde: ${cfgPath}`);
                break;
            }
        } catch (e) {
            console.log(`⚠️  config.json inválido (${cfgPath}): ${e.message}`);
        }
    }

    // 3. settings.json (DATA_DIR): override de servidor guardado por el
    //    usuario (menú interactivo o edición manual del archivo).
    const userSettings = settings || loadSettings();
    if (userSettings && userSettings.serverUrl) config.serverUrl = userSettings.serverUrl;

    // 4. Variables de entorno (útil para pruebas locales)
    if (env.CARNAGE_API_KEY) config.apiKey = env.CARNAGE_API_KEY;
    if (env.CARNAGE_SERVER_URL) config.serverUrl = env.CARNAGE_SERVER_URL;

    if (!config.apiKey) {
        console.error('\n❌ No hay API key configurada.');
        console.error('   Descarga el ejecutable oficial desde GitHub Releases, o crea un');
        console.error('   archivo config.json junto al programa con este contenido:');
        console.error('   { "apiKey": "TU_API_KEY", "serverUrl": "https://h3mccstats.cloud" }');
        return { ok: false, config };
    }
    return { ok: true, config };
}

module.exports = { resolveConfig, DEFAULT_SERVER_URL };
