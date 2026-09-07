/**
 * Tests de integración (Fase C2) de los endpoints públicos nuevos del
 * dashboard: /api/stats/rondas, /api/stats/saldos, /api/stats/roster.
 * Mismo patrón que app.test.js: createApp con dependencias falsas.
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
const { saveRoster } = require('../utils/roster');

function fakeSupabaseClient() {
    return {
        from() {
            return { select() { return { limit() { return Promise.resolve({ data: [], error: null }); } }; } };
        },
    };
}

function makeFakeSupabase(games = []) {
    return {
        client: fakeSupabaseClient(),
        async getAllValidGamesWithPlayers() { return games; },
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

function buildCtx({ games = [] } = {}) {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stats-dashboard-'));
    const supabase = makeFakeSupabase(games);
    const gamesCache = createGamesCache({ supabase, ttlMs: 60_000 });
    return {
        config: {
            API_KEY: 'test-api-key', ADMIN_KEY: 'test-admin-key', STRIPE_SECRET_KEY: null,
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

let tsBase = Date.now() - 60 * 60 * 1000;
function game(winner, minutesAfter) {
    const ts = new Date(tsBase + minutesAfter * 60 * 1000).toISOString();
    const [sL, sR] = winner === 'L' ? [50, 40] : [40, 50];
    return {
        game_unique_id: `g_${minutesAfter}`,
        timestamp: ts,
        map_name: 'Guardian',
        players: [
            { gamertag: 'Alfa', team_id: 0, score: sL / 2, kills: 10, deaths: 5, assists: 1 },
            { gamertag: 'Beta', team_id: 0, score: sL / 2, kills: 10, deaths: 5, assists: 1 },
            { gamertag: 'Cyto', team_id: 1, score: sR / 2, kills: 5, deaths: 10, assists: 1 },
            { gamertag: 'Delta', team_id: 1, score: sR / 2, kills: 5, deaths: 10, assists: 1 },
        ],
    };
}

test('GET /api/stats/rondas sin partidas -> session null', async () => {
    const ctx = buildCtx();
    await withServer(ctx, async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/stats/rondas`);
        assert.strictEqual(res.status, 200);
        const body = await res.json();
        assert.strictEqual(body.session, null);
        assert.strictEqual(typeof body.rondaMxn, 'number');
        assert.strictEqual(res.headers.get('cache-control'), 'public, max-age=30');
    });
});

test('GET /api/stats/rondas con sesión viva refleja el marcador', async () => {
    const games = [game('L', 0), game('L', 10)];
    const ctx = buildCtx({ games });
    await withServer(ctx, async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/stats/rondas`);
        const body = await res.json();
        assert.ok(body.session);
        assert.strictEqual(body.session.live, true);
        assert.strictEqual(body.session.gamesCount, 2);
        assert.strictEqual(body.session.enfrentamientos[0].rondasWon[0], 1);
        assert.strictEqual(body.session.cuenta[0].amountMxn, 25);
    });
});

test('GET /api/stats/saldos sin partidas -> saldos vacíos', async () => {
    const ctx = buildCtx();
    await withServer(ctx, async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/stats/saldos`);
        assert.strictEqual(res.status, 200);
        const body = await res.json();
        assert.strictEqual(body.gamesCount, 0);
        assert.deepStrictEqual(body.saldos, []);
        assert.strictEqual(body.sinceTs, null);
    });
});

test('GET /api/stats/saldos con deuda neta refleja el monto', async () => {
    const games = [game('L', 0), game('L', 10)];
    const ctx = buildCtx({ games });
    await withServer(ctx, async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/stats/saldos`);
        const body = await res.json();
        assert.strictEqual(body.gamesCount, 2);
        assert.strictEqual(body.saldos.length, 1);
        assert.strictEqual(body.saldos[0].amount, 25);
        assert.deepStrictEqual(body.saldos[0].winners.sort(), ['Alfa', 'Beta']);
    });
});

test('GET /api/stats/roster expone solo gamertag/known/totalGames, nunca JIDs', async () => {
    const games = [game('L', 0)];
    const ctx = buildCtx({ games });
    saveRoster(ctx.outputDir, {
        version: 1,
        links: [
            { jids: ['5215512345678@c.us', '987654321@lid'], gamertag: 'Alfa', known: true },
            { jids: ['5215500000001@c.us'], gamertag: 'Nuevo', known: false },
        ],
    });
    await withServer(ctx, async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/stats/roster`);
        assert.strictEqual(res.status, 200);
        const text = await res.text();
        assert.ok(!text.includes('@'), `no debe haber @: ${text}`);
        assert.ok(!/pn:|lid:/i.test(text), `no debe haber pn:/lid:: ${text}`);
        assert.ok(!/\d{8,}/.test(text), `no debe haber corridas de >=8 dígitos: ${text}`);

        const body = JSON.parse(text);
        assert.strictEqual(body.length, 2);
        const alfa = body.find(p => p.gamertag === 'Alfa');
        assert.strictEqual(alfa.known, true);
        assert.strictEqual(alfa.totalGames, 1);
        assert.deepStrictEqual(Object.keys(alfa).sort(), ['gamertag', 'known', 'totalGames']);
        const nuevo = body.find(p => p.gamertag === 'Nuevo');
        assert.strictEqual(nuevo.known, false);
        assert.strictEqual(nuevo.totalGames, 0);
    });
});
