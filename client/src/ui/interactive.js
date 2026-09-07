'use strict';

const readline = require('readline');

const paths = require('../paths');
const { resolveConfig } = require('../config');
const { loadSettings, saveSettings, ensureInstallId } = require('../settings');
const { enableAutostart, disableAutostart, launchBackgroundInstance } = require('../autostart');
const { checkForUpdates } = require('../updater');
const { startStatusServer, queryRunningInstance, shutdownRunningInstance, drainRunningInstance } = require('../statusServer');
const { startWatcher } = require('../watcher');
const { verifyServerConnection } = require('../sender');
const { drain } = require('../reporter');
const { STATE } = require('../state');
const { writeStatus, buildStatus } = require('../statusFile');
const spool = require('../spool');
const { LOG_FILE } = require('../logger');

const DISCORD_URL = 'https://discord.gg/yD6nGZ3KQX';
const DRAIN_INTERVAL_MS = 60 * 1000;
const STATUS_WRITE_INTERVAL_MS = 30 * 1000;

// ============== MODO INTERACTIVO (doble clic de siempre) ==============

function ask(question) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => rl.question(question, answer => { rl.close(); resolve(answer.trim()); }));
}

async function askYesNo(question) {
    for (; ;) {
        const a = (await ask(question)).toLowerCase();
        if (['s', 'si', 'sí', 'y'].includes(a)) return true;
        if (['n', 'no'].includes(a)) return false;
        console.log('   Responde S o N, porfa.');
    }
}

function fmtAgo(ts) {
    if (!ts) return 'ninguna todavía';
    const min = Math.round((Date.now() - ts) / 60000);
    if (min < 1) return 'hace un momento';
    if (min < 60) return `hace ${min} min`;
    const h = Math.round(min / 60);
    return h < 24 ? `hace ${h} h` : `hace ${Math.round(h / 24)} días`;
}

/**
 * Pregunta el gamertag UNA sola vez (settings.gamertag queda '' si se
 * omite, para no volver a preguntar). Es puramente informativo para el
 * servidor (X-Gamertag-Hint): no bloquea nada si se deja vacío.
 */
async function ensureGamertagAsked(settings) {
    if (settings.gamertag !== undefined) return settings.gamertag;
    console.log('\n¿Cuál es tu gamertag de Xbox? (ayuda a identificar tus partidas, opcional)');
    const answer = await ask('Gamertag (Enter para omitir): ');
    saveSettings({ gamertag: answer || '' });
    return answer || '';
}

/**
 * Activa el modo automático: registra el arranque con Windows, lanza la
 * instancia invisible y programa el cierre de esta ventana. beforeLaunch
 * permite soltar recursos (watcher/puerto) antes de lanzar el fondo.
 */
async function activateAutomaticMode(entryScript, beforeLaunch = null) {
    if (!enableAutostart(paths.IS_PKG ? null : entryScript)) {
        console.log('\n⚠️  No pude registrar el arranque automático en Windows. Seguimos en modo manual.');
        return false;
    }
    saveSettings({ autostart: 'on' });
    if (beforeLaunch) await beforeLaunch();
    launchBackgroundInstance(paths.IS_PKG ? null : entryScript);
    console.log('\n✅ ¡Listo! El modo automático quedó activado.');
    console.log('   Desde ahora me prendo solo cuando prendas tu compu y tus retas');
    console.log('   se suben solitas. Esta ventana se cierra en 15 segundos.');
    setTimeout(() => process.exit(0), 15000);
    return true;
}

async function promptActivation() {
    console.log('╔══════════════════════════════════════════════════╗');
    console.log('║              ¡NUEVO! MODO AUTOMÁTICO             ║');
    console.log('╚══════════════════════════════════════════════════╝\n');
    console.log('¿Quieres que el registro de partidas se encienda');
    console.log('solo cada vez que prendas tu compu?\n');
    console.log('Así ya no tienes que abrir nada: tus retas se');
    console.log('suben solitas al bot.\n');
    return askYesNo('Escribe S para activar, N para seguir como antes: ');
}

async function interactiveMenu(inst, config, version, entryScript) {
    console.log(`✅ El modo automático está ACTIVO en segundo plano (v${inst.version}).`);
    console.log(`   Corriendo desde: ${new Date(inst.startedAt).toLocaleString()}`);
    console.log(`   Partidas enviadas: ${inst.reportsSent} · Última: ${fmtAgo(inst.lastReportAt)}`);
    console.log(`   Pendientes: ${inst.pending ?? 0} · Fallidas: ${inst.failed ?? 0}`);
    console.log(`   Bitácora: ${LOG_FILE}\n`);

    for (; ;) {
        console.log('¿Qué quieres hacer?');
        console.log('  [1] Actualizar estado');
        console.log('  [2] Desactivar el modo automático');
        console.log('  [3] Salir');
        console.log('  [4] Reintentar envíos pendientes ahora');
        console.log('  [5] Buscar actualización');
        const opt = await ask('Opción: ');

        if (opt === '1') {
            const fresh = await queryRunningInstance();
            if (!fresh) {
                console.log('\n⚠️  La instancia de fondo ya no responde.\n');
                continue;
            }
            console.log(`\n   v${fresh.version} · corriendo desde ${new Date(fresh.startedAt).toLocaleString()}`);
            console.log(`   Partidas enviadas: ${fresh.reportsSent} · Última: ${fmtAgo(fresh.lastReportAt)}`);
            console.log(`   Pendientes: ${fresh.pending ?? 0} · Fallidas: ${fresh.failed ?? 0}\n`);
        } else if (opt === '2') {
            const sure = await askYesNo('\n¿Seguro? Ya no me prenderé solo y tendrás que abrirme a mano para registrar tus partidas (S/N): ');
            if (!sure) { console.log(''); continue; }
            disableAutostart();
            saveSettings({ autostart: 'no' });
            await shutdownRunningInstance();
            console.log('\n👋 Listo: modo automático desactivado y registro de fondo detenido.');
            const manual = await askYesNo('¿Dejo esta ventana registrando en modo manual mientras tanto? (S/N): ');
            if (manual) return runManualWatch(loadSettings(), config, version, entryScript);
            console.log('\nHasta la próxima. Puedes cerrar esta ventana.');
            return;
        } else if (opt === '3') {
            console.log('\nTodo sigue corriendo en el fondo. Puedes cerrar esta ventana.');
            return;
        } else if (opt === '4') {
            console.log('\n🔄 Pidiéndole a la instancia de fondo que reintente los pendientes...');
            const ok = await drainRunningInstance();
            console.log(ok
                ? '   Listo, ya está reintentando.\n'
                : '   ⚠️  No se pudo contactar a la instancia de fondo.\n');
        } else if (opt === '5') {
            console.log('\n⚠️  Buscando actualización: si hay una nueva versión, puede fallar al');
            console.log('   reemplazar el .exe mientras el modo automático sigue corriendo.');
            await checkForUpdates(version);
        } else {
            console.log('   Opción no válida.\n');
        }
    }
}

async function runManualWatch(settings, config, version, entryScript) {
    STATE.version = version;
    STATE.mode = 'manual';

    STATE.serverReachable = await verifyServerConnection(config);

    const runDrain = () => drain({ config, version }).catch(err => console.error('Error al drenar la cola de reportes:', err));

    const statusServer = await startStatusServer('manual', version, {
        getStatus: () => buildStatus(STATE),
        onDrain: runDrain,
    });
    const watcher = startWatcher(config, version);

    const drainInterval = setInterval(runDrain, DRAIN_INTERVAL_MS);
    const statusInterval = setInterval(() => writeStatus(STATE), STATUS_WRITE_INTERVAL_MS);
    writeStatus(STATE);

    console.log('\n📡 REGISTRO ACTIVO');
    console.log('   No cierres esta ventana mientras juegas para guardar tus stats.');
    const pending = spool.listPending().length;
    const failed = spool.countFailed();
    if (pending > 0 || failed > 0) {
        console.log(`   Pendientes: ${pending} · Fallidas: ${failed} (usa el flag --drain-now para reintentar sin abrir el juego)`);
    }
    if (settings.autostart === 'no') {
        console.log('\n💡 ¿Cansado de abrirme a mano? Escribe A y Enter para activar el modo automático.');
        const rl = readline.createInterface({ input: process.stdin });
        rl.on('line', async (line) => {
            if (line.trim().toLowerCase() !== 'a') return;
            console.log('\n⚙️  Activando el modo automático...');
            await activateAutomaticMode(entryScript, async () => {
                rl.close();
                clearInterval(drainInterval);
                clearInterval(statusInterval);
                await watcher.close();
                if (statusServer) statusServer.close();
            });
        });
    }
    console.log(`\n🎮 Discord: ${DISCORD_URL}`);
}

async function runInteractive(entryScript, version) {
    console.clear();
    console.log('╔══════════════════════════════════════════════════════════╗');
    console.log('║               CARNAGE REPORTER - HALO 3                  ║');
    console.log(`║                 Registro de Estadísticas v${version}        ║`);
    console.log('╚══════════════════════════════════════════════════════════╝\n');

    // Resolver configuración (API key y servidor)
    const { ok, config } = resolveConfig();
    if (!ok) {
        console.log('\nPresiona Ctrl+C para salir.');
        return;
    }

    // Con una instancia de fondo corriendo NO se busca update desde aquí:
    // el exe está bloqueado por ella y el reemplazo fallaría; ella misma se
    // actualiza sola (al arrancar y cada 24 h).
    let running = await queryRunningInstance();
    if (!running) await checkForUpdates(version);

    const settings = loadSettings();

    // Identidad de la instalación (Fase B3): se manda siempre; el gamertag
    // es puramente informativo y se pregunta una sola vez.
    config.installId = ensureInstallId();
    const gamertag = await ensureGamertagAsked(settings);
    if (gamertag) config.gamertag = gamertag;

    if (!running && settings.autostart === 'on') {
        console.log('♻️  El modo automático está activado pero no estaba corriendo. Lo arranco...');
        launchBackgroundInstance(paths.IS_PKG ? null : entryScript);
        await new Promise(r => setTimeout(r, 1500));
        running = await queryRunningInstance();
    }

    if (running) return interactiveMenu(running, config, version, entryScript);

    if (settings.autostart === undefined && process.platform === 'win32') {
        if (await promptActivation()) {
            if (await activateAutomaticMode(entryScript)) return;
        } else {
            saveSettings({ autostart: 'no' });
            console.log('\n👍 Va, seguimos como antes.');
        }
    }

    await runManualWatch(loadSettings(), config, version, entryScript);
}

module.exports = { runInteractive };
