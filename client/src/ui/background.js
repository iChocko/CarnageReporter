'use strict';

const { BASE_DIR } = require('../paths');
const { setupFileLogging } = require('../logger');
const { resolveConfig } = require('../config');
const { loadSettings, ensureInstallId } = require('../settings');
const { startStatusServer } = require('../statusServer');
const { checkForUpdates } = require('../updater');
const { verifyServerConnection } = require('../sender');
const { startWatcher } = require('../watcher');
const { drain } = require('../reporter');
const { STATE } = require('../state');
const { writeStatus, buildStatus } = require('../statusFile');
const spool = require('../spool');

// ============== MODO SEGUNDO PLANO (--background) ==============
// Sin ventana, sin prompts: Windows nos arranca vía la clave Run + el .vbs.
// Todo va a la bitácora, y el estado se consulta abriendo el exe a mano
// (--status) o con status.json / GET 127.0.0.1:47613 (Fase B4).

const DRAIN_INTERVAL_MS = 60 * 1000;
const STATUS_WRITE_INTERVAL_MS = 30 * 1000;
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

async function runBackground(version) {
    const settings = loadSettings();
    setupFileLogging(process.env.CARNAGE_LOG_LEVEL || settings.logLevel || 'info');
    console.log(`🚀 CarnageReporter v${version} arrancando en segundo plano (${BASE_DIR})`);
    // Invisible no puede tronar en silencio Y morir: se registra y se sigue
    process.on('uncaughtException', (e) => console.error('Error no capturado:', e));
    process.on('unhandledRejection', (e) => console.error('Promesa rechazada:', e));

    STATE.version = version;
    STATE.mode = 'background';

    const { ok, config } = resolveConfig(process.env, process.execPath, process.cwd(), settings);
    if (!ok) {
        console.error('Sin API key configurada; no puedo registrar partidas. Saliendo.');
        process.exit(1);
    }
    config.installId = ensureInstallId();
    if (settings.gamertag) config.gamertag = settings.gamertag;

    const runDrain = () => drain({ config, version }).catch(err => console.error('Error al drenar la cola de reportes:', err));

    const server = await startStatusServer('background', version, {
        getStatus: () => buildStatus(STATE),
        onDrain: runDrain,
    });
    if (!server) {
        console.log('Ya hay otra instancia corriendo; me retiro para no duplicar reportes.');
        process.exit(0);
    }

    // Nadie va a volver a abrir el exe a mano: las actualizaciones llegan
    // solas — al arrancar la compu y luego una revisión diaria silenciosa.
    await checkForUpdates(version);
    STATE.lastUpdateCheck = Date.now();
    setInterval(() => {
        checkForUpdates(version).catch(() => { }).finally(() => { STATE.lastUpdateCheck = Date.now(); });
    }, 24 * 60 * 60 * 1000);

    STATE.serverReachable = await verifyServerConnection(config);
    startWatcher(config, version);
    console.log('📡 Registro activo (modo automático). Vigilando la carpeta de MCC.');

    // Un XML pendiente no depende solo de eventos del watcher: si el
    // servidor estuvo caído, este timer es el que reintenta sin necesitar
    // que llegue una partida nueva.
    setInterval(runDrain, DRAIN_INTERVAL_MS);
    setInterval(() => spool.pruneFailed(30), PRUNE_INTERVAL_MS);
    setInterval(() => writeStatus(STATE), STATUS_WRITE_INTERVAL_MS);
    writeStatus(STATE);
}

module.exports = { runBackground };
