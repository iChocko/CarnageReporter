'use strict';

const http = require('http');

// ============== INSTANCIA ÚNICA Y ESTADO LOCAL ==============
// Un mini-servidor HTTP SOLO en 127.0.0.1 hace doble trabajo: si el puerto
// está ocupado ya hay otra instancia (evita partidas reportadas doble), y
// además le da a la apertura manual una forma de consultar el estado de la
// instancia de fondo o pedirle que se apague.

const STATUS_PORT = 47613;
const STATS = { startedAt: Date.now(), reportsSent: 0, lastReportAt: null };

function startStatusServer(mode, version) {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            if (req.method === 'POST' && req.url === '/shutdown') {
                res.end('bye');
                console.log('🛑 Apagado solicitado desde otra instancia local.');
                setTimeout(() => process.exit(0), 200);
                return;
            }
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({
                app: 'CarnageReporter', version, mode,
                startedAt: STATS.startedAt, reportsSent: STATS.reportsSent, lastReportAt: STATS.lastReportAt
            }));
        });
        server.on('error', () => resolve(null)); // puerto ocupado: ya hay otra instancia
        server.listen(STATUS_PORT, '127.0.0.1', () => resolve(server));
    });
}

function queryRunningInstance() {
    return new Promise((resolve) => {
        const req = http.get({ host: '127.0.0.1', port: STATUS_PORT, path: '/', timeout: 1500 }, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
    });
}

function shutdownRunningInstance() {
    return new Promise((resolve) => {
        const req = http.request(
            { host: '127.0.0.1', port: STATUS_PORT, path: '/shutdown', method: 'POST', timeout: 1500 },
            (res) => { res.on('data', () => { }); res.on('end', () => resolve(true)); }
        );
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
        req.end();
    });
}

module.exports = { startStatusServer, queryRunningInstance, shutdownRunningInstance, STATUS_PORT, STATS };
