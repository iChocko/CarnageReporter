'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const chokidar = require('chokidar');

const { IS_PKG, BASE_DIR } = require('./paths');
const { parseXML } = require('./parser');
const { sendReport } = require('./sender');
const { STATS } = require('./statusServer');

function getMCCTempPath() {
    const windowsPath = path.join(os.homedir(), 'AppData', 'LocalLow', 'MCC', 'Temporary');
    // Junto al exe cuando está empaquetado: arrancados por Windows el cwd es System32
    const localPath = path.join(IS_PKG ? BASE_DIR : process.cwd(), 'Maps_to_Rename');

    if (fs.existsSync(localPath)) {
        return localPath;
    }

    if (process.platform === 'win32') {
        if (!fs.existsSync(windowsPath)) {
            try {
                fs.mkdirSync(windowsPath, { recursive: true });
            } catch { /* si falla, el fs.existsSync de abajo lo detecta y sigue con otra ruta */ }
        }
        if (fs.existsSync(windowsPath)) {
            return windowsPath;
        }
    }

    if (!fs.existsSync(localPath)) {
        fs.mkdirSync(localPath, { recursive: true });
    }
    return localPath;
}

// ============== PROCESAMIENTO ==============

const processedFiles = new Set();

async function processXMLFile(filePath, config, version) {
    const filename = path.basename(filePath);

    if (processedFiles.has(filename)) return;
    if (!filename.includes('mpcarnagereport') && !filename.includes('asq_')) return;
    if (filename.includes('test_trigger')) return;

    console.log(`\n📦 Nueva partida registrada: ${filename}`);
    processedFiles.add(filename);

    try {
        const { gameData, players } = parseXML(filePath);
        console.log(`   🔸 Mapa: ${gameData.mapName} | Jugadores: ${players.length}`);

        console.log(`   🔹 Enviando estadísticas al servidor...`);
        const result = await sendReport(config, gameData, players, filename, version);

        if (result.kind === 'retry') {
            console.log(`   🔄 Reintentando envío...`);
            processedFiles.delete(filename);
            setTimeout(() => processXMLFile(filePath, config, version), 5000);
            return;
        }

        const body = result.body || {};
        if (body.status === 'processed') {
            STATS.reportsSent++;
            STATS.lastReportAt = Date.now();
            console.log(`   ✅ Datos guardados correctamente.`);
        } else if (body.status === 'duplicate') {
            console.log(`   ⏭️  Esta partida ya estaba en el sistema.`);
        } else if (body.status === 'voided') {
            console.log(`   🚫 Partida anulada (${body.reason}): no cuenta para stats.`);
        } else if (body.status === 'skipped') {
            console.log(`   ⏭️  Partida de matchmaking ignorada (solo se registran customs 2v2).`);
        } else {
            console.log(`   ⚠️  Servidor: ${body.message || body.error || result.status}`);
        }

        try {
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }
            setTimeout(() => processedFiles.delete(filename), 5000);
        } catch {
            setTimeout(() => processedFiles.delete(filename), 10000);
        }

    } catch (error) {
        console.error(`   ❌ Error: ${error.message}`);
    }
}

function startWatcher(config, version) {
    const watchDir = getMCCTempPath();
    const watcher = chokidar.watch(path.join(watchDir, '*.xml'), {
        persistent: true,
        ignoreInitial: true,
        usePolling: true,
        interval: 2000,
        awaitWriteFinish: {
            stabilityThreshold: 1500,
            pollInterval: 100
        }
    });

    const handler = (filePath) => processXMLFile(filePath, config, version);
    watcher.on('add', handler);
    watcher.on('change', handler);
    watcher.on('error', (error) => console.error('❌ Error en el sistema de monitoreo:', error));

    process.on('SIGINT', () => {
        console.log('\n\n👋 Cerrando programa. Hasta la próxima.');
        watcher.close();
        process.exit(0);
    });
    return watcher;
}

module.exports = { startWatcher, getMCCTempPath, processXMLFile };
