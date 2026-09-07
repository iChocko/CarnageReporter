'use strict';

const fs = require('fs');
const path = require('path');
const { DATA_DIR, ensureDataDir } = require('./paths');

// ============== LOG A ARCHIVO (modo segundo plano) ==============
// Invisible no significa mudo: todo lo que normalmente iría a la consola
// queda en carnage_client.log dentro de DATA_DIR, con rotación simple a 1 MB.
// Hasta v1.6 el log vivía junto al exe (BASE_DIR); ver paths.js.

const LOG_FILE = path.join(DATA_DIR, 'carnage_client.log');
const LOG_MAX_BYTES = 1024 * 1024;

/**
 * @param {'info'|'debug'} [level] 'debug' además escribe lo que se mande con
 *   console.debug (silencioso en 'info', el nivel normal en producción).
 */
function setupFileLogging(level = 'info') {
    ensureDataDir();
    const emit = (prefix, args) => {
        const text = args
            .map(a => (a instanceof Error ? (a.stack || a.message) : (typeof a === 'string' ? a : JSON.stringify(a))))
            .join(' ');
        try {
            if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > LOG_MAX_BYTES) {
                const old = path.join(DATA_DIR, 'carnage_client.old.log');
                try { fs.unlinkSync(old); } catch { /* no había log viejo que rotar */ }
                fs.renameSync(LOG_FILE, old);
            }
            fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}]${prefix} ${text}\n`);
        } catch { /* logging a archivo es best-effort, nunca debe tronar el cliente */ }
    };
    console.log = (...args) => emit('', args);
    console.error = (...args) => emit(' [ERROR]', args);
    console.debug = (...args) => { if (level === 'debug') emit(' [DEBUG]', args); };
    console.clear = () => { };
}

module.exports = { setupFileLogging, LOG_FILE, LOG_MAX_BYTES };
