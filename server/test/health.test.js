/**
 * Tests de server/health.js con dependencias falsas (sin Supabase, WhatsApp,
 * Puppeteer ni disco real): estados ok/degraded/down, el código HTTP que le
 * corresponde a cada uno, el cacheo de `cacheMs`, y que la alerta solo se
 * dispare en la TRANSICIÓN a 'down' (no en cada refresco mientras sigue caído).
 */

const { test } = require('node:test');
const assert = require('assert');

const { createHealthCheck } = require('../health');

/** Cliente Supabase falso: `.from().select().limit()` es un thenable (como el real). */
function fakeSupabase({ configured = true, error = null, delayMs = 0 } = {}) {
    let selectCalls = 0;
    const client = configured ? {
        from() {
            return {
                select() {
                    return {
                        limit() {
                            selectCalls++;
                            return {
                                then(resolve) {
                                    if (delayMs > 0) {
                                        setTimeout(() => resolve({ error }), delayMs);
                                    } else {
                                        resolve({ error });
                                    }
                                    return this;
                                },
                                // Promise.race necesita un .catch real para no tronar si nunca se usa
                                catch() { return this; },
                            };
                        },
                    };
                },
            };
        },
    } : null;
    return { client, get selectCalls() { return selectCalls; } };
}

function fakeWhatsapp({ enabled = false, status = 'disabled' } = {}) {
    return { enabled, getStatus: () => ({ status }) };
}

function fakeRes() {
    return {
        statusCode: null,
        body: null,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; },
    };
}

function baseDeps(overrides = {}) {
    return {
        supabase: fakeSupabase(),
        whatsapp: fakeWhatsapp(),
        renderer: { lastOkAt: null },
        getSchedulerJobs: () => [],
        outputDir: '/tmp/does-not-matter',
        version: '9.9.9',
        statfs: () => { throw new Error('no soportado en este runtime de prueba'); },
        ...overrides,
    };
}

test('status ok + 200 cuando Supabase responde y WhatsApp está deshabilitado', async () => {
    const health = createHealthCheck(baseDeps());
    const res = fakeRes();
    await health.handler({}, res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.status, 'ok');
    assert.strictEqual(res.body.version, '9.9.9');
    assert.strictEqual(res.body.checks.supabase.ok, true);
    assert.strictEqual(res.body.checks.whatsapp.enabled, false);
    assert.strictEqual(res.body.checks.disk.outputFreeMb, null); // statfs lanzó
});

test('status degraded + 200 cuando WhatsApp está habilitado pero no listo', async () => {
    const health = createHealthCheck(baseDeps({
        whatsapp: fakeWhatsapp({ enabled: true, status: 'waiting_qr' }),
    }));
    const res = fakeRes();
    await health.handler({}, res);

    assert.strictEqual(res.statusCode, 200); // degradado, NO 503
    assert.strictEqual(res.body.status, 'degraded');
    assert.strictEqual(res.body.checks.whatsapp.state, 'waiting_qr');
});

test('status down + 503 cuando Supabase no está configurado', async () => {
    const health = createHealthCheck(baseDeps({ supabase: fakeSupabase({ configured: false }) }));
    const res = fakeRes();
    await health.handler({}, res);

    assert.strictEqual(res.statusCode, 503);
    assert.strictEqual(res.body.status, 'down');
    assert.strictEqual(res.body.checks.supabase.ok, false);
});

test('status down + 503 cuando la query de Supabase devuelve error', async () => {
    const health = createHealthCheck(baseDeps({
        supabase: fakeSupabase({ error: { message: 'conexión rechazada' } }),
    }));
    const res = fakeRes();
    await health.handler({}, res);

    assert.strictEqual(res.statusCode, 503);
    assert.strictEqual(res.body.checks.supabase.error, 'conexión rechazada');
});

test('cachea el resultado durante cacheMs: no vuelve a golpear Supabase', async () => {
    const supabase = fakeSupabase();
    let nowMs = 1000;
    const health = createHealthCheck(baseDeps({ supabase, cacheMs: 10_000, now: () => nowMs }));

    await health.handler({}, fakeRes());
    assert.strictEqual(supabase.selectCalls, 1);

    nowMs += 5000; // dentro del cache
    await health.handler({}, fakeRes());
    assert.strictEqual(supabase.selectCalls, 1, 'no debió repetir la consulta dentro del cache');

    nowMs += 10_000; // fuera del cache
    await health.handler({}, fakeRes());
    assert.strictEqual(supabase.selectCalls, 2, 'debió refrescar tras vencer el cache');
});

test('alertFn se dispara SOLO en la transición a down, no en cada refresco mientras sigue caído', async () => {
    const calls = [];
    const alertFn = async (level, text, opts) => { calls.push({ level, text, opts }); return true; };
    let nowMs = 0;
    const health = createHealthCheck(baseDeps({
        supabase: fakeSupabase({ configured: false }),
        cacheMs: 1000,
        now: () => nowMs,
        alertFn,
    }));

    await health.handler({}, fakeRes());
    nowMs += 2000;
    await health.handler({}, fakeRes());
    nowMs += 2000;
    await health.handler({}, fakeRes());

    assert.strictEqual(calls.length, 1, 'la alerta no debe repetirse mientras sigue down');
    assert.strictEqual(calls[0].level, 'error');
    assert.strictEqual(calls[0].opts.key, 'health');
});

test('vuelve a alertar si el estado se recupera y cae otra vez (nueva transición)', async () => {
    const calls = [];
    const alertFn = async (level) => { calls.push(level); return true; };
    let down = true;
    let nowMs = 0;
    const health = createHealthCheck(baseDeps({
        supabase: { get client() { return down ? null : fakeSupabase().client; } },
        cacheMs: 100,
        now: () => nowMs,
        alertFn,
    }));

    await health.handler({}, fakeRes()); // down -> alerta #1
    nowMs += 1000;
    down = false;
    await health.handler({}, fakeRes()); // ok, sin alerta
    nowMs += 1000;
    down = true;
    await health.handler({}, fakeRes()); // down otra vez -> alerta #2

    assert.strictEqual(calls.length, 2);
});

test('expone los jobs del scheduler y el lastOkAt del renderer tal cual', async () => {
    const jobs = [{ name: 'backup', status: 'scheduled' }];
    const health = createHealthCheck(baseDeps({
        renderer: { lastOkAt: '2026-01-01T00:00:00.000Z' },
        getSchedulerJobs: () => jobs,
    }));
    const res = fakeRes();
    await health.handler({}, res);

    assert.deepStrictEqual(res.body.checks.scheduler.jobs, jobs);
    assert.strictEqual(res.body.checks.renderer.lastOkAt, '2026-01-01T00:00:00.000Z');
});

test('outputFreeMb se calcula desde statfs cuando el runtime lo soporta', async () => {
    const health = createHealthCheck(baseDeps({
        statfs: () => ({ bavail: 1000, bsize: 1024 * 1024 }), // 1000 bloques de 1MB
    }));
    const res = fakeRes();
    await health.handler({}, res);

    assert.strictEqual(res.body.checks.disk.outputFreeMb, 1000);
});
