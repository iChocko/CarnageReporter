'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const chokidar = require('chokidar');

const { IS_PKG, BASE_DIR } = require('./paths');
const spool = require('./spool');
const { drain } = require('./reporter');

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

// ============== PROCESAMIENTO (Fase B3: watcher + spool) ==============
// El watcher ya NO envía nada él mismo: solo mete el XML a la cola en disco
// (spool.intake) y dispara un drain. Toda la lógica de reintento/backoff/
// dedupe vive en reporter.js y spool.js, sobrevive a un reinicio del proceso.

const STARTUP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function isCarnageReportFile(filename) {
    return filename.includes('mpcarnagereport') || filename.includes('asq_');
}

function startWatcher(config, version) {
    const watchDir = getMCCTempPath();
    let ready = false;

    const watcher = chokidar.watch(path.join(watchDir, '*.xml'), {
        persistent: true,
        ignoreInitial: false,
        usePolling: true,
        interval: 2000,
        awaitWriteFinish: {
            stabilityThreshold: 1500,
            pollInterval: 100
        }
    });

    const handleEvent = (filePath) => {
        const filename = path.basename(filePath);
        if (!isCarnageReportFile(filename)) return;
        if (filename.includes('test_trigger')) return;

        if (!ready) {
            // Arranque (ignoreInitial:false trae también lo que ya estaba en
            // la carpeta): un XML viejo que MCC no borró, o que quedó de una
            // instalación anterior del cliente, no se toma de golpe.
            let stat;
            try {
                stat = fs.statSync(filePath);
            } catch {
                return; // ya no existe, evento obsoleto
            }
            if (Date.now() - stat.mtimeMs > STARTUP_MAX_AGE_MS) {
                console.log(`   ⏭️  Ignorando XML viejo del arranque (>7 días): ${filename}`);
                return;
            }
        }

        const name = spool.intake(filePath);
        if (name) {
            console.log(`\n📦 Nueva partida en la cola de envío: ${filename}`);
        }
        drain({ config, version }).catch(err => console.error('Error al drenar la cola de reportes:', err));
    };

    watcher.on('add', handleEvent);
    watcher.on('change', handleEvent);
    watcher.on('ready', () => { ready = true; });
    watcher.on('error', (error) => console.error('❌ Error en el sistema de monitoreo:', error));

    process.on('SIGINT', () => {
        console.log('\n\n👋 Cerrando programa. Hasta la próxima.');
        watcher.close();
        process.exit(0);
    });
    return watcher;
}

module.exports = { startWatcher, getMCCTempPath, isCarnageReportFile };
