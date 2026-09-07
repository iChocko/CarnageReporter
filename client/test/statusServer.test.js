/**
 * Tests de client/src/statusServer.js (Fase B4): GET / sigue abierto sin
 * autenticación, pero POST /shutdown y POST /drain ahora exigen el token
 * que se escribe en DATA_DIR\instance.json al arrancar.
 */

const { test, after } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    startStatusServer, queryRunningInstance, shutdownRunningInstance, drainRunningInstance,
    readInstanceFile
} = require('../src/statusServer');

function tmpDataDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'carnage-statussrv-test-'));
}

// Los tests corren en serie contra el puerto fijo 47613: cada uno arranca su
// propio server y lo cierra antes de que termine, para no pisarse.
let currentServer = null;
after(async () => {
    if (currentServer) await new Promise(r => currentServer.close(r));
});

async function withStatusServer(opts, fn) {
    const server = await startStatusServer('manual', '1.7.0', opts);
    currentServer = server;
    assert.ok(server, 'el servidor debió poder levantar en el puerto de pruebas');
    try {
        await fn();
    } finally {
        await new Promise(r => server.close(r));
        currentServer = null;
    }
}

console.log('\n— instance.json —');

test('al arrancar escribe instance.json con puerto y token', async () => {
    const dataDir = tmpDataDir();
    await withStatusServer({ dataDir }, async () => {
        const inst = readInstanceFile(dataDir);
        assert.ok(inst);
        assert.strictEqual(inst.port, 47613);
        assert.strictEqual(typeof inst.token, 'string');
        assert.strictEqual(inst.token.length, 32); // randomBytes(16).toString('hex')
    });
});

console.log('\n— GET / —');

test('GET / sigue abierto sin autenticación, expone el status extra', async () => {
    const dataDir = tmpDataDir();
    await withStatusServer({ dataDir, getStatus: () => ({ pending: 3, failed: 1 }) }, async () => {
        const inst = await queryRunningInstance();
        assert.ok(inst);
        assert.strictEqual(inst.app, 'CarnageReporter');
        assert.strictEqual(inst.version, '1.7.0');
        assert.strictEqual(inst.mode, 'manual');
        assert.strictEqual(inst.pending, 3);
        assert.strictEqual(inst.failed, 1);
    });
});

console.log('\n— POST /shutdown —');

test('POST /shutdown sin token -> 401, no apaga', async () => {
    const dataDir = tmpDataDir();
    await withStatusServer({ dataDir }, async () => {
        const res = await fetch('http://127.0.0.1:47613/shutdown', { method: 'POST' });
        assert.strictEqual(res.status, 401);
        // sigue vivo: un GET / posterior responde
        const inst = await queryRunningInstance();
        assert.ok(inst);
    });
});

test('shutdownRunningInstance lee el token de instance.json y sí apaga', async () => {
    const dataDir = tmpDataDir();
    const server = await startStatusServer('manual', '1.7.0', { dataDir });
    currentServer = server;

    // El handler real agenda process.exit(0) 200ms después de responder: se
    // reemplaza por un no-op mientras dura el test para no matar el proceso
    // de pruebas (node --test corre todos los archivos en el mismo proceso).
    const realExit = process.exit;
    process.exit = () => { };
    try {
        const ok = await shutdownRunningInstance(dataDir);
        assert.strictEqual(ok, true);
        await new Promise(r => setTimeout(r, 250)); // deja pasar el setTimeout(200) sin efecto
    } finally {
        process.exit = realExit;
        await new Promise(r => server.close(r));
        currentServer = null;
    }
});

console.log('\n— POST /drain —');

test('POST /drain sin token -> 401, no invoca onDrain', async () => {
    const dataDir = tmpDataDir();
    let drainCalls = 0;
    await withStatusServer({ dataDir, onDrain: async () => { drainCalls++; } }, async () => {
        const res = await fetch('http://127.0.0.1:47613/drain', { method: 'POST' });
        assert.strictEqual(res.status, 401);
        assert.strictEqual(drainCalls, 0);
    });
});

test('drainRunningInstance con el token correcto invoca onDrain y responde 200', async () => {
    const dataDir = tmpDataDir();
    let drainCalls = 0;
    await withStatusServer({ dataDir, onDrain: async () => { drainCalls++; } }, async () => {
        const ok = await drainRunningInstance(dataDir);
        assert.strictEqual(ok, true);
        assert.strictEqual(drainCalls, 1);
    });
});

test('token de una instance.json ajena (u otro dataDir) no sirve', async () => {
    const dataDir = tmpDataDir();
    const otherDataDir = tmpDataDir();
    fs.writeFileSync(path.join(otherDataDir, 'instance.json'), JSON.stringify({ port: 47613, token: 'a'.repeat(32) }));

    await withStatusServer({ dataDir }, async () => {
        const ok = await shutdownRunningInstance(otherDataDir);
        assert.strictEqual(ok, false);
        // el server real sigue vivo
        const inst = await queryRunningInstance();
        assert.ok(inst);
    });
});
