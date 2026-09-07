/**
 * Tests de server/domain/gamesCache.js: TTL, dedupe de llamadas concurrentes
 * e invalidación. Reloj falso (sin setTimeout real) para probar el TTL sin
 * esperas de verdad.
 */

const { test } = require('node:test');
const assert = require('assert');

const { createGamesCache, DEFAULT_TTL_MS } = require('../domain/gamesCache');

function fakeClock(start = 1_000_000) {
    let now = start;
    return { now: () => now, advance: (ms) => { now += ms; } };
}

function fakeSupabase() {
    let calls = 0;
    let resolveList = [];
    return {
        get calls() { return calls; },
        async getAllValidGamesWithPlayers(format) {
            calls++;
            const id = calls;
            return new Promise((resolve) => {
                resolveList.push(() => resolve([{ id, format }]));
            });
        },
        async getRecentGamesWithPlayers(limit, format) {
            calls++;
            return [{ limit, format, call: calls }];
        },
        flush() { resolveList.forEach(r => r()); resolveList = []; },
    };
}

test('DEFAULT_TTL_MS es 5 minutos', () => {
    assert.strictEqual(DEFAULT_TTL_MS, 5 * 60 * 1000);
});

test('cachea getAllValidGamesWithPlayers por formato dentro del TTL', async () => {
    const clock = fakeClock();
    let calls = 0;
    const supabase = {
        async getAllValidGamesWithPlayers(format) { calls++; return [{ format, call: calls }]; },
    };
    const cache = createGamesCache({ supabase, ttlMs: 1000, now: clock.now });

    const a = await cache.getAllValidGamesWithPlayers('2v2');
    const b = await cache.getAllValidGamesWithPlayers('2v2');
    assert.strictEqual(calls, 1);
    assert.deepStrictEqual(a, b);

    // Formato distinto: cache separado, sí llama de nuevo
    const c = await cache.getAllValidGamesWithPlayers('4v4');
    assert.strictEqual(calls, 2);
    assert.notDeepStrictEqual(a, c);
});

test('expira tras el TTL y vuelve a consultar', async () => {
    const clock = fakeClock();
    let calls = 0;
    const supabase = {
        async getAllValidGamesWithPlayers(format) { calls++; return [{ format, call: calls }]; },
    };
    const cache = createGamesCache({ supabase, ttlMs: 1000, now: clock.now });

    await cache.getAllValidGamesWithPlayers('2v2');
    assert.strictEqual(calls, 1);

    clock.advance(999);
    await cache.getAllValidGamesWithPlayers('2v2');
    assert.strictEqual(calls, 1, 'todavía dentro del TTL');

    clock.advance(2); // total 1001ms > ttlMs
    await cache.getAllValidGamesWithPlayers('2v2');
    assert.strictEqual(calls, 2, 'expiró y volvió a consultar');
});

test('deduplica llamadas concurrentes con los mismos argumentos', async () => {
    const clock = fakeClock();
    const supabase = fakeSupabase();
    const cache = createGamesCache({ supabase, ttlMs: 1000, now: clock.now });

    const p1 = cache.getAllValidGamesWithPlayers('2v2');
    const p2 = cache.getAllValidGamesWithPlayers('2v2');
    await new Promise((resolve) => setImmediate(resolve)); // deja correr los microtasks internos del cache
    assert.strictEqual(supabase.calls, 1, 'una sola llamada real en vuelo para ambas');

    supabase.flush();
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.deepStrictEqual(r1, r2);
    assert.strictEqual(supabase.calls, 1);
});

test('getRecentGamesWithPlayers cachea por combinación limit+format', async () => {
    const clock = fakeClock();
    let calls = 0;
    const supabase = {
        async getRecentGamesWithPlayers(limit, format) { calls++; return [{ limit, format, call: calls }]; },
    };
    const cache = createGamesCache({ supabase, ttlMs: 1000, now: clock.now });

    await cache.getRecentGamesWithPlayers(10, '2v2');
    await cache.getRecentGamesWithPlayers(10, '2v2');
    assert.strictEqual(calls, 1);

    await cache.getRecentGamesWithPlayers(5, '2v2');
    assert.strictEqual(calls, 2, 'limit distinto es una llave de cache distinta');

    await cache.getRecentGamesWithPlayers(10, '4v4');
    assert.strictEqual(calls, 3, 'format distinto es una llave de cache distinta');
});

test('invalidateAll() limpia todo el cache (ambos métodos)', async () => {
    const clock = fakeClock();
    let calls = 0;
    const supabase = {
        async getAllValidGamesWithPlayers() { calls++; return [calls]; },
        async getRecentGamesWithPlayers() { calls++; return [calls]; },
    };
    const cache = createGamesCache({ supabase, ttlMs: 60_000, now: clock.now });

    await cache.getAllValidGamesWithPlayers('2v2');
    await cache.getRecentGamesWithPlayers(10, '2v2');
    assert.strictEqual(calls, 2);

    cache.invalidateAll();

    await cache.getAllValidGamesWithPlayers('2v2');
    await cache.getRecentGamesWithPlayers(10, '2v2');
    assert.strictEqual(calls, 4, 'ambos métodos vuelven a consultar tras invalidar');
});

test('un rechazo no deja el cache envenenado: el siguiente intento reintenta', async () => {
    const clock = fakeClock();
    let calls = 0;
    const supabase = {
        async getAllValidGamesWithPlayers() {
            calls++;
            if (calls === 1) throw new Error('boom');
            return ['ok'];
        },
    };
    const cache = createGamesCache({ supabase, ttlMs: 1000, now: clock.now });

    await assert.rejects(() => cache.getAllValidGamesWithPlayers('2v2'), /boom/);
    const result = await cache.getAllValidGamesWithPlayers('2v2');
    assert.deepStrictEqual(result, ['ok']);
    assert.strictEqual(calls, 2);
});
