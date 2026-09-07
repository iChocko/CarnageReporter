'use strict';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { DATA_DIR, ensureDataDir } = require('./paths');

// ============== INSTANCIA ÚNICA Y ESTADO LOCAL ==============
// Un mini-servidor HTTP SOLO en 127.0.0.1 hace triple trabajo: si el puerto
// está ocupado ya hay otra instancia (evita partidas reportadas doble), le
// da a la apertura manual una forma de consultar el estado de la instancia
// de fondo, y (Fase B4) permite pedirle que drene el spool o se apague sin
// tener que matar el proceso a mano.
//
// GET / se queda abierto (es solo lectura de estado); /shutdown y /drain
// exigen el token que se escribe en DATA_DIR\instance.json al arrancar —
// cualquier proceso que pueda LEER ese archivo (o sea, el mismo usuario de
// Windows) puede usarlos, pero ya no cualquiera que sepa el puerto fijo.

const STATUS_PORT = 47613;

function instanceFilePath(dataDir = DATA_DIR) {
    return path.join(dataDir, 'instance.json');
}

function readInstanceFile(dataDir = DATA_DIR) {
    try {
        return JSON.parse(fs.readFileSync(instanceFilePath(dataDir), 'utf-8'));
    } catch {
        return null;
    }
}

function hasValidToken(req, token) {
    const header = req.headers['authorization'] || '';
    return header === `Bearer ${token}`;
}

function sendJSON(res, status, obj) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
}

/**
 * @param {string} mode 'manual' | 'background'
 * @param {string} version
 * @param {object} [opts]
 * @param {string} [opts.dataDir]
 * @param {() => object} [opts.getStatus] snapshot adicional a devolver en GET /
 * @param {() => Promise<any>} [opts.onDrain] invocado (sin esperar la respuesta) en POST /drain
 */
function startStatusServer(mode, version, opts = {}) {
    const { dataDir = DATA_DIR, getStatus = () => ({}), onDrain = null } = opts;
    return new Promise((resolve) => {
        const token = crypto.randomBytes(16).toString('hex');

        const server = http.createServer((req, res) => {
            if (req.method === 'POST' && req.url === '/shutdown') {
                if (!hasValidToken(req, token)) return sendJSON(res, 401, { error: 'unauthorized' });
                res.end('bye');
                console.log('🛑 Apagado solicitado desde otra instancia local.');
                setTimeout(() => process.exit(0), 200);
                return;
            }

            if (req.method === 'POST' && req.url === '/drain') {
                if (!hasValidToken(req, token)) return sendJSON(res, 401, { error: 'unauthorized' });
                if (onDrain) onDrain().catch((e) => console.error('Error en drain manual:', e));
                return sendJSON(res, 200, { ok: true });
            }

            sendJSON(res, 200, { app: 'CarnageReporter', version, mode, ...getStatus() });
        });

        server.on('error', () => resolve(null)); // puerto ocupado: ya hay otra instancia
        server.listen(STATUS_PORT, '127.0.0.1', () => {
            try {
                ensureDataDir(dataDir);
                fs.writeFileSync(instanceFilePath(dataDir), JSON.stringify({ port: STATUS_PORT, token }, null, 2));
            } catch { /* si no se pudo escribir, /shutdown y /drain locales quedan inaccesibles hasta reiniciar */ }
            resolve(server);
        });
    });
}

// agent: false en las tres llamadas de abajo: son peticiones locales
// esporádicas (una consulta de estado, un shutdown/drain puntual), no vale
// la pena pooling — y evita que el agente global reuse un socket quedado
// de una instancia anterior que ya cerró en el mismo puerto fijo.
function queryRunningInstance() {
    return new Promise((resolve) => {
        const req = http.get({ host: '127.0.0.1', port: STATUS_PORT, path: '/', timeout: 1500, agent: false }, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
    });
}

function authedPost(urlPath, dataDir) {
    return new Promise((resolve) => {
        const inst = readInstanceFile(dataDir);
        const headers = inst ? { Authorization: `Bearer ${inst.token}` } : {};
        const req = http.request(
            { host: '127.0.0.1', port: STATUS_PORT, path: urlPath, method: 'POST', timeout: 1500, headers, agent: false },
            (res) => { res.on('data', () => { }); res.on('end', () => resolve(res.statusCode === 200)); }
        );
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
        req.end();
    });
}

function shutdownRunningInstance(dataDir = DATA_DIR) {
    return authedPost('/shutdown', dataDir);
}

function drainRunningInstance(dataDir = DATA_DIR) {
    return authedPost('/drain', dataDir);
}

module.exports = {
    startStatusServer, queryRunningInstance, shutdownRunningInstance, drainRunningInstance,
    readInstanceFile, instanceFilePath, STATUS_PORT
};
