/**
 * Tests de GET /api/admin/games (Fase C2): listado admin de las últimas N
 * partidas, incluyendo anuladas (con motivo), para el panel admin-lite del
 * dashboard. Mismo patrón que app.test.js, con un cliente Supabase falso que
 * imita el query-builder encadenable de supabase-js.
 */

const { test } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createApp } = require('../app');
const { createGamesCache } = require('../domain/gamesCache');
const { makeLock } = require('../state/locks');
const { logger } = require('../logger');

/** Fake query builder de la tabla `games`: soporta select/eq/order/limit y es "thenable". */
function gamesTable(rows) {
    let result = [...rows];
    const builder = {
        select() { return builder; },
        eq(col, val) { result = result.filter(r => r[col] === val); return builder; },
        order(col, { ascending } = {}) {
            result = [...result].sort((a, b) => ascending
                ? new Date(a[col]) - new Date(b[col])
                : new Date(b[col]) - new Date(a[col]));
            return builder;
        },
        limit(n) { result = result.slice(0, n); return builder; },
        then(resolve, reject) { return Promise.resolve({ data: result, error: null }).then(resolve, reject); },
    };
    return builder;
}

/** Fake query builder de la tabla `players`: soporta select/in. */
function playersTable(rows) {
    const builder = {
        select() { return builder; },
        in(col, ids) {
            const filtered = rows.filter(r => ids.includes(r[col]));
            return Promise.resolve({ data: filtered, error: null });
        },
    };
    return builder;
}

function fakeSupabaseClient({ games = [], players = [] } = {}) {
    return {
        from(table) {
            if (table === 'games') return gamesTable(games);
            if (table === 'players') return playersTable(players);
            throw new Error(`tabla no soportada en el fake: ${table}`);
        },
    };
}

function makeFakeSupabase({ games = [], players = [] } = {}) {
    return {
        client: fakeSupabaseClient({ games, players }),
        async getAllValidGamesWithPlayers() { return []; },
        async getRecentGamesWithPlayers() { return []; },
        async findGamesByIdPrefix() { return []; },
        getProcessedCount() { return 0; },
    };
}

function makeFakeWhatsapp() {
    return {
        enabled: false,
        isReady() { return false; },
        getStatus() { return { status: 'disconnected' }; },
        groupIdFor() { return null; },
        async sendImage() { return true; },
        async sendMessage() { return true; },
        getOwnIds() { return new Set(); },
        async resolveLidPn(jids) { return jids.map(() => ({})); },
        async getContactInfo() { return {}; },
        getQR() { return null; },
        async listGroups() { return []; },
        async getGroupParticipants() { return []; },
        registerCommand() { /* no-op */ },
        setAlertHandler() { /* no-op */ },
    };
}

function buildCtx({ games = [], players = [], adminKey = 'test-admin-key' } = {}) {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-games-list-'));
    const supabase = makeFakeSupabase({ games, players });
    const gamesCache = createGamesCache({ supabase, ttlMs: 60_000 });
    return {
        config: {
            API_KEY: 'test-api-key', ADMIN_KEY: adminKey, STRIPE_SECRET_KEY: null,
            CORS_ORIGIN: null, LEADERBOARD_MIN_GAMES: '5', WHATSAPP_ADMIN_JIDS: '',
        },
        logger,
        supabase,
        whatsapp: makeFakeWhatsapp(),
        discord: {}, discord4v4: {}, renderer: {},
        alerts: { alert: async () => false },
        outputDir,
        gamesCache,
        locks: {
            withRosterLock: makeLock(), withForfeitLock: makeLock(), withAnularLock: makeLock(),
            withAjusteLock: makeLock(), withSaldosLock: makeLock(),
        },
        version: 'test',
        getSchedulerJobs: () => [],
    };
}

async function withServer(ctx, fn) {
    const app = createApp(ctx);
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const { port } = server.address();
    try {
        await fn(`http://127.0.0.1:${port}`);
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
}

const GAMES = [
    { game_unique_id: 'g1', map_name: 'Guardian', timestamp: '2026-01-01T00:00:00.000Z', format: '2v2', is_voided: false, void_reason: null },
    { game_unique_id: 'g2', map_name: 'Sandtrap', timestamp: '2026-01-02T00:00:00.000Z', format: '2v2', is_voided: true, void_reason: 'manual' },
    { game_unique_id: 'g3', map_name: 'Narrows', timestamp: '2026-01-03T00:00:00.000Z', format: '4v4', is_voided: false, void_reason: null },
];
const PLAYERS = [
    { game_unique_id: 'g1', gamertag: 'Alfa', team_id: 0, score: 25, kills: 20, deaths: 10 },
    { game_unique_id: 'g1', gamertag: 'Beta', team_id: 1, score: 15, kills: 10, deaths: 20 },
    { game_unique_id: 'g2', gamertag: 'Cyto', team_id: 0, score: 25, kills: 20, deaths: 10 },
];

test('GET /api/admin/games sin X-Admin-Key -> 401', async () => {
    const ctx = buildCtx({ games: GAMES, players: PLAYERS });
    await withServer(ctx, async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/admin/games`);
        assert.strictEqual(res.status, 401);
    });
});

test('GET /api/admin/games con key correcta lista incluyendo anuladas, más reciente primero', async () => {
    const ctx = buildCtx({ games: GAMES, players: PLAYERS });
    await withServer(ctx, async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/admin/games`, { headers: { 'X-Admin-Key': 'test-admin-key' } });
        assert.strictEqual(res.status, 200);
        const body = await res.json();
        assert.strictEqual(body.length, 3);
        assert.strictEqual(body[0].game_unique_id, 'g3'); // más reciente primero
        const voided = body.find(g => g.game_unique_id === 'g2');
        assert.strictEqual(voided.is_voided, true);
        assert.strictEqual(voided.void_reason, 'manual');
        assert.strictEqual(voided.players.length, 1);
        assert.strictEqual(voided.players[0].gamertag, 'Cyto');

        const g1 = body.find(g => g.game_unique_id === 'g1');
        assert.strictEqual(g1.players.length, 2);
    });
});

test('GET /api/admin/games?format=4v4 filtra por formato', async () => {
    const ctx = buildCtx({ games: GAMES, players: PLAYERS });
    await withServer(ctx, async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/admin/games?format=4v4`, { headers: { 'X-Admin-Key': 'test-admin-key' } });
        const body = await res.json();
        assert.strictEqual(body.length, 1);
        assert.strictEqual(body[0].game_unique_id, 'g3');
    });
});

test('GET /api/admin/games?limit=1 respeta el límite', async () => {
    const ctx = buildCtx({ games: GAMES, players: PLAYERS });
    await withServer(ctx, async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/admin/games?limit=1`, { headers: { 'X-Admin-Key': 'test-admin-key' } });
        const body = await res.json();
        assert.strictEqual(body.length, 1);
        assert.strictEqual(body[0].game_unique_id, 'g3');
    });
});

test('GET /api/admin/games sin partidas -> lista vacía', async () => {
    const ctx = buildCtx({ games: [], players: [] });
    await withServer(ctx, async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/admin/games`, { headers: { 'X-Admin-Key': 'test-admin-key' } });
        const body = await res.json();
        assert.deepStrictEqual(body, []);
    });
});
