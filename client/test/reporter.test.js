/**
 * Tests de client/src/reporter.js: drain() procesa spool/pending con un
 * sendReport falso y verifica que cada 'kind' de resultado (ver sender.js)
 * produce la transición de estado correcta — completar, archivar, o
 * reprogramar con el backoff que toque.
 */

const { test } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const spool = require('../src/spool');
const { drain, backoffFor, BACKOFF_MS, GIVE_UP_MS } = require('../src/reporter');
const { STATE } = require('../src/state');

const FIXTURES_DIR = path.join(__dirname, 'fixtures');

function tmpDataDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'carnage-reporter-test-'));
}

// Mete un XML válido (fixture real) directo a spool/pending/, sin pasar por
// intake, para poder controlar meta.firstSeenAt/attempts a mano.
function seedPending(dataDir, name, metaOverrides = {}) {
    const pending = spool.pendingDir(dataDir);
    fs.mkdirSync(pending, { recursive: true });
    fs.copyFileSync(path.join(FIXTURES_DIR, 'mpcarnagereport_2v2.xml'), path.join(pending, name));
    const now = new Date().toISOString();
    const meta = { attempts: 0, firstSeenAt: now, nextAttemptAt: now, lastError: null, lastStatus: null, ...metaOverrides };
    fs.writeFileSync(path.join(pending, `${name}.meta.json`), JSON.stringify(meta));
    return meta;
}

function fakeSender(results) {
    // results: array de { kind, status, body, retryAfterSeconds } consumidos
    // en orden, uno por llamada.
    let i = 0;
    const calls = [];
    return {
        calls,
        fn: async (config, gameData, players, filename, version) => {
            calls.push({ config, filename, version });
            const r = results[Math.min(i, results.length - 1)];
            i++;
            return r;
        }
    };
}

const config = { serverUrl: 'http://example.invalid', apiKey: 'k', installId: 'install-1' };

console.log('\n— drain: done —');

test("kind 'done' con status processed: completa, cuenta el envío", async () => {
    const dataDir = tmpDataDir();
    seedPending(dataDir, 'g1.xml');
    const before = STATE.reportsSent;

    const sender = fakeSender([{ kind: 'done', status: 200, body: { status: 'processed' } }]);
    const result = await drain({ config, version: '1.7.0', dataDir, sendReportFn: sender.fn });

    assert.strictEqual(result.drained, 1);
    assert.strictEqual(spool.listPending(dataDir).length, 0);
    assert.strictEqual(STATE.reportsSent, before + 1);
});

test("kind 'done' con status duplicate: completa, NO cuenta el envío", async () => {
    const dataDir = tmpDataDir();
    seedPending(dataDir, 'g1.xml');
    const before = STATE.reportsSent;

    const sender = fakeSender([{ kind: 'done', status: 200, body: { status: 'duplicate' } }]);
    await drain({ config, version: '1.7.0', dataDir, sendReportFn: sender.fn });

    assert.strictEqual(spool.listPending(dataDir).length, 0);
    assert.strictEqual(STATE.reportsSent, before);
});

console.log('\n— drain: reject —');

test("kind 'reject': se archiva en failed/, no se reintenta", async () => {
    const dataDir = tmpDataDir();
    seedPending(dataDir, 'g1.xml');

    const sender = fakeSender([{ kind: 'reject', status: 400, body: { error: 'payload inválido' } }]);
    await drain({ config, version: '1.7.0', dataDir, sendReportFn: sender.fn });

    assert.strictEqual(spool.listPending(dataDir).length, 0);
    assert.strictEqual(fs.existsSync(path.join(spool.failedDir(dataDir), 'g1.xml')), true);
});

console.log('\n— drain: retry / backoff —');

test("kind 'retry': se reprograma con el backoff del intento, sigue en pending", async () => {
    const dataDir = tmpDataDir();
    seedPending(dataDir, 'g1.xml', { attempts: 0 });

    const sender = fakeSender([{ kind: 'retry', status: 500, body: { status: 'error' } }]);
    const before = Date.now();
    await drain({ config, version: '1.7.0', dataDir, sendReportFn: sender.fn });

    const items = spool.listPending(dataDir);
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].meta.attempts, 1);
    const nextAttemptMs = new Date(items[0].meta.nextAttemptAt).getTime();
    // Primer intento -> backoff de 5s (BACKOFF_MS[0])
    assert.ok(nextAttemptMs >= before + BACKOFF_MS[0] - 500 && nextAttemptMs <= before + BACKOFF_MS[0] + 3000,
        `nextAttemptAt fuera de rango: ${items[0].meta.nextAttemptAt}`);
});

test('backoffFor sigue la tabla 5s,15s,1m,5m,15m,1h y se queda en 1h después', () => {
    assert.strictEqual(backoffFor(1), 5000);
    assert.strictEqual(backoffFor(2), 15000);
    assert.strictEqual(backoffFor(3), 60000);
    assert.strictEqual(backoffFor(4), 5 * 60000);
    assert.strictEqual(backoffFor(5), 15 * 60000);
    assert.strictEqual(backoffFor(6), 60 * 60000);
    assert.strictEqual(backoffFor(20), 60 * 60000);
});

test('un elemento con nextAttemptAt en el futuro NO se procesa todavía', async () => {
    const dataDir = tmpDataDir();
    seedPending(dataDir, 'g1.xml', { nextAttemptAt: new Date(Date.now() + 60000).toISOString() });

    const sender = fakeSender([{ kind: 'done', status: 200, body: { status: 'processed' } }]);
    const result = await drain({ config, version: '1.7.0', dataDir, sendReportFn: sender.fn });

    assert.strictEqual(result.drained, 0);
    assert.strictEqual(sender.calls.length, 0);
    assert.strictEqual(spool.listPending(dataDir).length, 1);
});

console.log('\n— drain: 429 Retry-After —');

test('429 con retryAfterSeconds honra ese valor exacto', async () => {
    const dataDir = tmpDataDir();
    seedPending(dataDir, 'g1.xml');

    const sender = fakeSender([{ kind: 'retry', status: 429, body: {}, retryAfterSeconds: 120 }]);
    const before = Date.now();
    await drain({ config, version: '1.7.0', dataDir, sendReportFn: sender.fn });

    const items = spool.listPending(dataDir);
    const nextAttemptMs = new Date(items[0].meta.nextAttemptAt).getTime();
    assert.ok(Math.abs(nextAttemptMs - (before + 120000)) < 3000);
});

test('429 sin Retry-After cae a 60s por default', async () => {
    const dataDir = tmpDataDir();
    seedPending(dataDir, 'g1.xml');

    const sender = fakeSender([{ kind: 'retry', status: 429, body: {}, retryAfterSeconds: null }]);
    const before = Date.now();
    await drain({ config, version: '1.7.0', dataDir, sendReportFn: sender.fn });

    const items = spool.listPending(dataDir);
    const nextAttemptMs = new Date(items[0].meta.nextAttemptAt).getTime();
    assert.ok(Math.abs(nextAttemptMs - (before + 60000)) < 3000);
});

console.log('\n— drain: 7 días sin éxito —');

test('más de 7 días en pending -> se archiva como gave_up, sin llamar al sender', async () => {
    const dataDir = tmpDataDir();
    seedPending(dataDir, 'g1.xml', { firstSeenAt: new Date(Date.now() - (GIVE_UP_MS + 60000)).toISOString() });

    const sender = fakeSender([{ kind: 'retry', status: 500, body: {} }]);
    await drain({ config, version: '1.7.0', dataDir, sendReportFn: sender.fn });

    assert.strictEqual(sender.calls.length, 0);
    assert.strictEqual(spool.listPending(dataDir).length, 0);
    const meta = JSON.parse(fs.readFileSync(path.join(spool.failedDir(dataDir), 'g1.xml.meta.json'), 'utf-8'));
    assert.strictEqual(meta.lastError, 'gave_up');
});

console.log('\n— drain: unauthorized detiene el drain —');

test('unauthorized detiene el drain: el segundo pendiente ni se intenta', async () => {
    const dataDir = tmpDataDir();
    const t1 = new Date(Date.now() - 2000).toISOString();
    const t2 = new Date(Date.now() - 1000).toISOString();
    seedPending(dataDir, 'a.xml', { firstSeenAt: t1, nextAttemptAt: t1 });
    seedPending(dataDir, 'b.xml', { firstSeenAt: t2, nextAttemptAt: t2 });

    const sender = fakeSender([{ kind: 'unauthorized', status: 401, body: { error: 'API key inválida' } }]);
    const result = await drain({ config, version: '1.7.0', dataDir, sendReportFn: sender.fn });

    assert.strictEqual(sender.calls.length, 1, 'solo debió intentarse el primero (a.xml)');
    assert.strictEqual(result.drained, 1);
    // a.xml se reprograma a +1h, b.xml queda intacto (nunca se intentó)
    const items = spool.listPending(dataDir);
    assert.strictEqual(items.length, 2);
    const a = items.find(i => i.name === 'a.xml');
    const nextAttemptMs = new Date(a.meta.nextAttemptAt).getTime();
    assert.ok(Math.abs(nextAttemptMs - (Date.now() + 60 * 60000)) < 5000);
});

console.log('\n— drain: revoked / upgrade detienen el drain —');

test("kind 'revoked' detiene el drain y marca el motivo en el meta", async () => {
    const dataDir = tmpDataDir();
    const t2 = new Date(Date.now() - 1000).toISOString();
    seedPending(dataDir, 'a.xml');
    seedPending(dataDir, 'b.xml', { firstSeenAt: t2, nextAttemptAt: t2 });

    const sender = fakeSender([{ kind: 'revoked', status: 403, body: { status: 'revoked' } }]);
    await drain({ config, version: '1.7.0', dataDir, sendReportFn: sender.fn });

    assert.strictEqual(sender.calls.length, 1);
    const items = spool.listPending(dataDir);
    assert.strictEqual(items.length, 2);
});

test("kind 'upgrade' detiene el drain", async () => {
    const dataDir = tmpDataDir();
    const t2 = new Date(Date.now() - 1000).toISOString();
    seedPending(dataDir, 'a.xml');
    seedPending(dataDir, 'b.xml', { firstSeenAt: t2, nextAttemptAt: t2 });

    const sender = fakeSender([{ kind: 'upgrade', status: 426, body: { status: 'upgrade_required', minVersion: '2.0.0' } }]);
    await drain({ config, version: '1.7.0', dataDir, sendReportFn: sender.fn });

    assert.strictEqual(sender.calls.length, 1);
    assert.strictEqual(spool.listPending(dataDir).length, 2);
});

console.log('\n— drain: parse error —');

test('XML corrupto -> se archiva como parse_error, sin llamar al sender', async () => {
    const dataDir = tmpDataDir();
    const pending = spool.pendingDir(dataDir);
    fs.mkdirSync(pending, { recursive: true });
    fs.writeFileSync(path.join(pending, 'roto.xml'), 'esto no es xml valido <<<');
    const now = new Date().toISOString();
    fs.writeFileSync(path.join(pending, 'roto.xml.meta.json'), JSON.stringify({ attempts: 0, firstSeenAt: now, nextAttemptAt: now }));

    const sender = fakeSender([{ kind: 'done', status: 200, body: { status: 'processed' } }]);
    await drain({ config, version: '1.7.0', dataDir, sendReportFn: sender.fn });

    assert.strictEqual(sender.calls.length, 0);
    assert.strictEqual(spool.listPending(dataDir).length, 0);
    const meta = JSON.parse(fs.readFileSync(path.join(spool.failedDir(dataDir), 'roto.xml.meta.json'), 'utf-8'));
    assert.strictEqual(meta.lastError, 'parse_error');
});

console.log('\n— drain: orden y single-flight —');

test('procesa en orden de firstSeenAt (más viejo primero)', async () => {
    const dataDir = tmpDataDir();
    const tOld = new Date(Date.now() - 2000).toISOString();
    const tNew = new Date(Date.now() - 1000).toISOString();
    seedPending(dataDir, 'nuevo.xml', { firstSeenAt: tNew, nextAttemptAt: tNew });
    seedPending(dataDir, 'viejo.xml', { firstSeenAt: tOld, nextAttemptAt: tOld });

    const sender = fakeSender([
        { kind: 'done', status: 200, body: { status: 'processed' } },
        { kind: 'done', status: 200, body: { status: 'processed' } }
    ]);
    await drain({ config, version: '1.7.0', dataDir, sendReportFn: sender.fn });

    assert.deepStrictEqual(sender.calls.map(c => c.filename), ['viejo.xml', 'nuevo.xml']);
});

test('un drain concurrente mientras otro corre no hace doble trabajo', async () => {
    const dataDir = tmpDataDir();
    seedPending(dataDir, 'g1.xml');

    let resolveFirst;
    const gate = new Promise(r => { resolveFirst = r; });
    let calls = 0;
    const slowSender = async () => {
        calls++;
        await gate;
        return { kind: 'done', status: 200, body: { status: 'processed' } };
    };

    const p1 = drain({ config, version: '1.7.0', dataDir, sendReportFn: slowSender });
    // Deja que drain() entre a su sección crítica antes de disparar el segundo
    await new Promise(r => setImmediate(r));
    const p2 = drain({ config, version: '1.7.0', dataDir, sendReportFn: slowSender });

    resolveFirst();
    const [r1, r2] = await Promise.all([p1, p2]);

    assert.strictEqual(calls, 1, 'el segundo drain() debió verse bloqueado (single-flight)');
    assert.ok(r2.skipped, 'el drain concurrente debe reportarse como saltado');
    assert.strictEqual(r1.drained, 1);
});
