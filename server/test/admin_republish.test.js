/**
 * Tests de POST /api/admin/games/:id/republish (Fase A4): re-renderiza y
 * vuelve a publicar una partida YA guardada — la red de seguridad para
 * cuando el render o la publicación fallaron DESPUÉS del save-first. Mismo
 * patrón que admin_games_list.test.js (fake de supabase con findGamesByIdPrefix
 * + getGameWithPlayers, sin tocar la BD real).
 */

'use strict';

const { test } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createApp } = require('../app');
const { createGamesCache } = require('../domain/gamesCache');
const { makeLock } = require('../state/locks');
const { logger } = require('../logger');
const { OutboxUnavailableError } = require('../messaging/outboxStore');

const GAME_ROW = {
    game_unique_id: 'game-republish-1',
    game_enum: 0,
    is_matchmaking: false,
    is_teams_enabled: true,
    hopper_name: null,
    game_type_name: '2V2 HARDCORE TS',
    map_name: 'Guardian',
    map_code: 'asq_guardia',
    timestamp: '2026-06-15T20:00:00.000Z',
    duration: 600,
    playlist_name: null,
    last_match_incomplete: false,
    party_size: null,
    is_voided: false,
    void_reason: null,
    format: '2v2',
};
const PLAYER_ROWS = [
    { game_unique_id: 'game-republish-1', xbox_user_id: 'x1', gamertag: 'Alfa', team_id: 0, score: 25, kills: 20, deaths: 10, assists: 2 },
    { game_unique_id: 'game-republish-1', xbox_user_id: 'x2', gamertag: 'Beta', team_id: 0, score: 20, kills: 15, deaths: 12, assists: 3 },
    { game_unique_id: 'game-republish-1', xbox_user_id: 'x3', gamertag: 'Cyto', team_id: 1, score: 15, kills: 10, deaths: 20, assists: 1 },
    { game_unique_id: 'game-republish-1', xbox_user_id: 'x4', gamertag: 'Delta', team_id: 1, score: 10, kills: 8, deaths: 18, assists: 0 },
];

function makeFakeSupabase({ games = [GAME_ROW], players = PLAYER_ROWS } = {}) {
    return {
        async findGamesByIdPrefix(prefix) {
            return games.filter(g => g.game_unique_id.startsWith(prefix)).map(g => ({ game_unique_id: g.game_unique_id }));
        },
        async getGameWithPlayers(id) {
            const game = games.find(g => g.game_unique_id === id);
            if (!game) return null;
            return { game, players: players.filter(p => p.game_unique_id === id) };
        },
        async getAllValidGamesWithPlayers() { return []; },
        async getRecentGamesWithPlayers() { return []; },
        getProcessedCount() { return 0; },
    };
}

function makeFakeWhatsapp(overrides = {}) {
    const calls = { sendImage: [] };
    return {
        calls,
        enabled: true,
        isReady() { return true; },
        getStatus() { return { status: 'ready' }; },
        groupIdFor(format) { return format === '2v2' ? 'chat-2v2@g.us' : null; },
        async sendImage(imagePath, caption, chatId) { calls.sendImage.push({ imagePath, caption, chatId }); return true; },
        async sendMessage() { return true; },
        registerCommand() {},
        setAlertHandler() {},
        ...overrides,
    };
}

function makeFakeDiscord() {
    const calls = [];
    return { calls, async sendImage(pngPath, gameData, players) { calls.push({ pngPath, gameData, players }); return true; } };
}

function makeFakeRenderer() {
    const calls = [];
    return {
        calls,
        lastOkAt: null,
        async generatePNG(gameData, players, pngPath) {
            calls.push({ gameData, players, pngPath });
            fs.writeFileSync(pngPath, Buffer.from([0]));
        },
    };
}

function makeFakeOutboxStore({ unavailable = false } = {}) {
    const rows = new Map(); // dedupe_key -> row
    let nextId = 1;
    return {
        rows,
        async enqueue(row) {
            if (unavailable) throw new OutboxUnavailableError('tabla outbox no existe (fake)');
            if (row.dedupe_key && rows.has(row.dedupe_key)) {
                return { id: rows.get(row.dedupe_key).id, created: false };
            }
            const stored = { id: nextId++, status: 'pending', attempts: 0, ...row };
            if (row.dedupe_key) rows.set(row.dedupe_key, stored);
            return { id: stored.id, created: true };
        },
    };
}

function buildCtx(overrides = {}) {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-republish-test-'));
    const supabase = overrides.supabase || makeFakeSupabase();
    const gamesCache = createGamesCache({ supabase, ttlMs: 60_000 });
    const ctx = {
        config: {
            API_KEY: 'test-api-key', ADMIN_KEY: 'test-admin-key', STRIPE_SECRET_KEY: null,
            CORS_ORIGIN: null, LEADERBOARD_MIN_GAMES: '5', WHATSAPP_ADMIN_JIDS: '',
            OUTBOX_ENABLED: !!overrides.outboxStore,
        },
        logger,
        supabase,
        whatsapp: overrides.whatsapp || makeFakeWhatsapp(),
        discord: overrides.discord || makeFakeDiscord(),
        discord4v4: overrides.discord4v4 || makeFakeDiscord(),
        renderer: overrides.renderer || makeFakeRenderer(),
        alerts: overrides.alerts || { alert: async () => false },
        outputDir,
        gamesCache,
        locks: {
            withRosterLock: makeLock(), withForfeitLock: makeLock(), withAnularLock: makeLock(),
            withAjusteLock: makeLock(), withSaldosLock: makeLock(),
        },
        version: 'test',
        getSchedulerJobs: () => [],
    };
    if (overrides.outboxStore) {
        ctx.outboxStore = overrides.outboxStore;
        ctx.outboxWorker = { kick() {} };
    }
    return ctx;
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

function republish(baseUrl, id) {
    return fetch(`${baseUrl}/api/admin/games/${id}/republish`, {
        method: 'POST',
        headers: { 'X-Admin-Key': 'test-admin-key' },
    });
}

test('POST .../republish sin X-Admin-Key -> 401', async () => {
    const ctx = buildCtx();
    await withServer(ctx, async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/admin/games/${GAME_ROW.game_unique_id}/republish`, { method: 'POST' });
        assert.strictEqual(res.status, 401);
    });
});

test('POST .../republish de un ID inexistente -> 404', async () => {
    const ctx = buildCtx();
    await withServer(ctx, async (baseUrl) => {
        const res = await republish(baseUrl, 'no-existe-para-nada');
        assert.strictEqual(res.status, 404);
    });
});

test('POST .../republish (outbox apagado): re-renderiza y publica DIRECTO', async () => {
    const discord = makeFakeDiscord();
    const whatsapp = makeFakeWhatsapp();
    const renderer = makeFakeRenderer();
    const ctx = buildCtx({ discord, whatsapp, renderer });

    await withServer(ctx, async (baseUrl) => {
        const res = await republish(baseUrl, GAME_ROW.game_unique_id);
        assert.strictEqual(res.status, 200);
        const body = await res.json();
        assert.strictEqual(body.status, 'republished');
        assert.strictEqual(body.gameId, GAME_ROW.game_unique_id);
        assert.strictEqual(body.format, '2v2');
        assert.deepStrictEqual(body.publish, { discord: 'sent', whatsapp: 'sent' });

        assert.strictEqual(renderer.calls.length, 1);
        // El gameData reconstruido desde la fila de la BD trae las claves camelCase esperadas.
        assert.strictEqual(renderer.calls[0].gameData.gameUniqueId, GAME_ROW.game_unique_id);
        assert.strictEqual(renderer.calls[0].gameData.mapName, 'Guardian');
        assert.strictEqual(renderer.calls[0].players.length, 4);
        assert.ok(renderer.calls[0].players.some(p => p.gamertag === 'Alfa' && p.teamId === 0));

        assert.strictEqual(discord.calls.length, 1);
        assert.strictEqual(whatsapp.calls.sendImage.length, 1);
    });
});

test('POST .../republish (outbox prendido): encola en vez de publicar directo, idempotente', async () => {
    const discord = makeFakeDiscord();
    const whatsapp = makeFakeWhatsapp();
    const outboxStore = makeFakeOutboxStore();
    const ctx = buildCtx({ discord, whatsapp, outboxStore });

    await withServer(ctx, async (baseUrl) => {
        const res1 = await republish(baseUrl, GAME_ROW.game_unique_id);
        const body1 = await res1.json();
        assert.deepStrictEqual(body1.publish, { discord: 'queued', whatsapp: 'queued' });
        assert.strictEqual(discord.calls.length, 0, 'no debió publicar directo con el outbox prendido');
        assert.strictEqual(outboxStore.rows.size, 2);

        // Repetir la republicación reusa las mismas filas (dedupe_key) en vez de duplicar.
        const res2 = await republish(baseUrl, GAME_ROW.game_unique_id);
        const body2 = await res2.json();
        assert.strictEqual(res2.status, 200);
        assert.deepStrictEqual(body2.publish, { discord: 'queued', whatsapp: 'queued' });
        assert.strictEqual(outboxStore.rows.size, 2, 'republicar de nuevo no debe crear filas nuevas (mismo dedupe_key)');
    });
});

test('POST .../republish con outbox no disponible -> fallback directo', async () => {
    const discord = makeFakeDiscord();
    const whatsapp = makeFakeWhatsapp();
    const outboxStore = makeFakeOutboxStore({ unavailable: true });
    const ctx = buildCtx({ discord, whatsapp, outboxStore });

    await withServer(ctx, async (baseUrl) => {
        const res = await republish(baseUrl, GAME_ROW.game_unique_id);
        const body = await res.json();
        assert.deepStrictEqual(body.publish, { discord: 'sent', whatsapp: 'sent' });
        assert.strictEqual(discord.calls.length, 1);
        assert.strictEqual(whatsapp.calls.sendImage.length, 1);
    });
});
