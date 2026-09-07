'use strict';

const { BASE_DIR } = require('../paths');
const { setupFileLogging } = require('../logger');
const { resolveConfig } = require('../config');
const { startStatusServer } = require('../statusServer');
const { checkForUpdates } = require('../updater');
const { verifyServerConnection } = require('../sender');
const { startWatcher } = require('../watcher');

// ============== MODO SEGUNDO PLANO (--background) ==============
// Sin ventana, sin prompts: Windows nos arranca vía la clave Run + el .vbs.
// Todo va a la bitácora, y el estado se consulta abriendo el exe a mano.

async function runBackground(version) {
    setupFileLogging();
    console.log(`🚀 CarnageReporter v${version} arrancando en segundo plano (${BASE_DIR})`);
    // Invisible no puede tronar en silencio Y morir: se registra y se sigue
    process.on('uncaughtException', (e) => console.error('Error no capturado:', e));
    process.on('unhandledRejection', (e) => console.error('Promesa rechazada:', e));

    const { ok, config } = resolveConfig();
    if (!ok) {
        console.error('Sin API key configurada; no puedo registrar partidas. Saliendo.');
        process.exit(1);
    }

    const server = await startStatusServer('background', version);
    if (!server) {
        console.log('Ya hay otra instancia corriendo; me retiro para no duplicar reportes.');
        process.exit(0);
    }

    // Nadie va a volver a abrir el exe a mano: las actualizaciones llegan
    // solas — al arrancar la compu y luego una revisión diaria silenciosa.
    await checkForUpdates(version);
    setInterval(() => checkForUpdates(version).catch(() => { }), 24 * 60 * 60 * 1000);

    await verifyServerConnection(config);
    startWatcher(config, version);
    console.log('📡 Registro activo (modo automático). Vigilando la carpeta de MCC.');
}

module.exports = { runBackground };
