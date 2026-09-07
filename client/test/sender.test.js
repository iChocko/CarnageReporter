/**
 * Tests de client/src/sender.js: header X-API-Key y cuerpo JSON del reporte,
 * y la clasificación kind ('done'/'retry'/'reject'/'unauthorized') según el
 * status HTTP y el cuerpo de la respuesta.
 */

const { test } = require('node:test');
const assert = require('assert');
const http = require('http');

const { sendReport, verifyServerConnection } = require('../src/sender');

// Levanta un http.createServer real en un puerto libre (0) y responde según
// lo que indique el handler. Se cierra al terminar cada test.
function withServer(handler) {
    return new Promise((resolve) => {
        const server = http.createServer(handler);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            resolve({
                server,
                url: `http://127.0.0.1:${port}`,
                close: () => new Promise(r => server.close(r))
            });
        });
    });
}

const gameData = { gameUniqueId: 'g1', mapName: 'Guardian' };
const players = [{ gamertag: 'A' }];

console.log('\n— sendReport: header y cuerpo del request —');

test('manda X-API-Key y el JSON esperado', async () => {
    let received = null;
    const { url, close } = await withServer((req, res) => {
        let raw = '';
        req.on('data', c => raw += c);
        req.on('end', () => {
            received = { headers: req.headers, body: JSON.parse(raw) };
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'processed' }));
        });
    });

    const result = await sendReport({ serverUrl: url, apiKey: 'secret-key-123' }, gameData, players, 'file.xml', '1.6.0');

    assert.strictEqual(received.headers['x-api-key'], 'secret-key-123');
    assert.strictEqual(received.body.schemaVersion, 2);
    assert.strictEqual(received.body.clientVersion, '1.6.0');
    assert.strictEqual(received.body.filename, 'file.xml');
    assert.deepStrictEqual(received.body.gameData, gameData);
    assert.deepStrictEqual(received.body.players, players);
    assert.strictEqual(result.kind, 'done');

    await close();
});

console.log('\n— sendReport: clasificación por status HTTP —');

async function classify(status, body) {
    const { url, close } = await withServer((req, res) => {
        req.on('data', () => { });
        req.on('end', () => {
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(body === undefined ? '' : JSON.stringify(body));
        });
    });
    const result = await sendReport({ serverUrl: url, apiKey: 'k' }, gameData, players, 'f.xml', '1.6.0');
    await close();
    return result;
}

test('200 + status processed -> done', async () => {
    const r = await classify(200, { status: 'processed' });
    assert.strictEqual(r.kind, 'done');
    assert.strictEqual(r.status, 200);
});

test('200 + status duplicate/voided/skipped -> done', async () => {
    for (const status of ['duplicate', 'voided', 'skipped']) {
        const r = await classify(200, { status });
        assert.strictEqual(r.kind, 'done', `status=${status}`);
    }
});

test('200 + status error -> retry', async () => {
    const r = await classify(200, { status: 'error', message: 'boom' });
    assert.strictEqual(r.kind, 'retry');
});

test('400 -> reject', async () => {
    const r = await classify(400, { status: 'error', message: 'payload inválido' });
    assert.strictEqual(r.kind, 'reject');
    assert.strictEqual(r.status, 400);
});

test('401 -> unauthorized', async () => {
    const r = await classify(401, { status: 'error', message: 'API key inválida' });
    assert.strictEqual(r.kind, 'unauthorized');
});

test('403 -> unauthorized', async () => {
    const r = await classify(403, {});
    assert.strictEqual(r.kind, 'unauthorized');
});

test('429 -> retry', async () => {
    const r = await classify(429, {});
    assert.strictEqual(r.kind, 'retry');
});

test('500 -> retry', async () => {
    const r = await classify(500, { status: 'error' });
    assert.strictEqual(r.kind, 'retry');
});

test('200 con cuerpo JSON inválido -> reject (no se reintenta un 200)', async () => {
    const { url, close } = await withServer((req, res) => {
        req.on('data', () => { });
        req.on('end', () => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end('esto no es json{{{');
        });
    });
    const result = await sendReport({ serverUrl: url, apiKey: 'k' }, gameData, players, 'f.xml', '1.6.0');
    await close();
    assert.strictEqual(result.kind, 'reject');
    assert.strictEqual(result.body, null);
});

console.log('\n— sendReport: timeout —');

test('si el servidor no responde a tiempo, clasifica como retry', async () => {
    const { url, close } = await withServer((req, res) => {
        // nunca responde dentro del timeout de la prueba
        setTimeout(() => { try { res.end(); } catch { /* servidor ya cerrado */ } }, 2000);
    });

    const result = await sendReport({ serverUrl: url, apiKey: 'k' }, gameData, players, 'f.xml', '1.6.0', 200);
    assert.strictEqual(result.kind, 'retry');
    assert.strictEqual(result.status, null);

    await close();
});

test('sin servidor escuchando -> retry (sin conexión)', async () => {
    // Puerto que casi seguro nadie está escuchando en localhost
    const result = await sendReport({ serverUrl: 'http://127.0.0.1:1', apiKey: 'k' }, gameData, players, 'f.xml', '1.6.0', 500);
    assert.strictEqual(result.kind, 'retry');
});

console.log('\n— verifyServerConnection —');

test('no truena si el servidor está caído', async () => {
    // Solo verifica que no lance: el mensaje va a console.log
    await verifyServerConnection({ serverUrl: 'http://127.0.0.1:1' });
});

test('no truena si el servidor responde', async () => {
    const { url, close } = await withServer((req, res) => res.end('ok'));
    await verifyServerConnection({ serverUrl: url });
    await close();
});
