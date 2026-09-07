/**
 * Tests de integración de createApp (Fase A2) con dependencias falsas: nada
 * toca Supabase, WhatsApp, Discord ni Puppeteer reales. Arranca la app en un
 * puerto efímero y pega con fetch, como lo haría un cliente real.
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

/** Cliente Supabase falso: `.from().select().limit()` resuelve ok (health check). */
function fakeSupabaseClient() {
    return {
        from() {
            return {
                select() {
                    return {
                        limit() {
                            return Promise.resolve({ data: [], error: null });
                        },
                    };
                },
            };
        },
    };
}

function makeFakeSupabase(overrides = {}) {
    const existingIds = new Set();
    const calls = { saveGame: [], gameExists: [], setVoided: [], deleteGame: [] };
    return {
        client: fakeSupabaseClient(),
        calls,
        existingIds,
        async gameExists(id) {
            calls.gameExists.push(id);
            return existingIds.has(id);
        },
        async saveGame(gameData, players, meta) {
            calls.saveGame.push({ gameData: { ...gameData }, players, meta });
            existingIds.add(gameData.gameUniqueId);
        },
        async getAllValidGamesWithPlayers() {
            return [];
        },
        async getRecentGamesWithPlayers() {
            return [];
        },
        async findGamesByIdPrefix() {
            return [];
        },
        async deleteGame() { /* no-op */ },
        async setVoided(id, voided) {
            calls.setVoided.push({ id, voided });
        },
        getProcessedCount() {
            return 0;
        },
        ...overrides,
    };
}

function makeFakeWhatsapp(overrides = {}) {
    const calls = { sendImage: [], sendMessage: [] };
    return {
        enabled: false,
        calls,
        isReady() { return false; },
        getStatus() { return { status: 'disconnected' }; },
        groupIdFor() { return null; },
        async sendImage(imagePath, caption, chatId) {
            calls.sendImage.push({ imagePath, caption, chatId });
            return true;
        },
        async sendMessage(text, chatId, options) {
            calls.sendMessage.push({ text, chatId, options });
            return true;
        },
        getOwnIds() { return new Set(); },
        async resolveLidPn(jids) { return jids.map(() => ({})); },
        async getContactInfo() { return {}; },
        getQR() { return null; },
        async listGroups() { return []; },
        async getGroupParticipants() { return []; },
        registerCommand() { /* no-op */ },
        setAlertHandler() { /* no-op */ },
        ...overrides,
    };
}

function makeFakeDiscord() {
    const calls = [];
    return { calls, async sendImage(pngPath, gameData, players) { calls.push({ pngPath, gameData, players }); return true; } };
}

function makeFakeRenderer() {
    return {
        lastOkAt: null,
        async generatePNG(gameData, players, pngPath) {
            fs.writeFileSync(pngPath, Buffer.from([0]));
            this.lastOkAt = new Date().toISOString();
        },
    };
}

function buildCtx(overrides = {}) {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-test-'));
    const supabase = overrides.supabase || makeFakeSupabase();
    const gamesCache = createGamesCache({ supabase });
    const ctx = {
        config: {
            API_KEY: 'test-api-key',
            ADMIN_KEY: 'test-admin-key',
            STRIPE_SECRET_KEY: null,
            CORS_ORIGIN: null,
            LEADERBOARD_MIN_GAMES: '5',
            WHATSAPP_ADMIN_JIDS: '',
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
            withRosterLock: makeLock(),
            withForfeitLock: makeLock(),
            withAnularLock: makeLock(),
            withAjusteLock: makeLock(),
            withSaldosLock: makeLock(),
        },
        version: 'test',
        getSchedulerJobs: () => [],
    };
    return ctx;
}

async function withServer(ctx, fn) {
    const app = createApp(ctx);
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const { port } = server.address();
    const baseUrl = `http://127.0.0.1:${port}`;
    try {
        await fn(baseUrl, ctx);
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
}

function validPayload(overrides = {}) {
    return {
        gameData: {
            gameUniqueId: overrides.gameUniqueId || `game-${Math.random().toString(36).slice(2)}`,
            mapName: null,
            mapCode: 'asq_guardia',
            timestamp: new Date().toISOString(),
            duration: 600,
            isMatchmaking: false,
            isTeamsEnabled: true,
            ...overrides.gameData,
        },
        players: overrides.players || [
            { gamertag: 'Alfa', teamId: 0, kills: 20, deaths: 10, assists: 2, score: 25 },
            { gamertag: 'Beta', teamId: 0, kills: 15, deaths: 12, assists: 3, score: 20 },
            { gamertag: 'Cyto', teamId: 1, kills: 10, deaths: 20, assists: 1, score: 15 },
            { gamertag: 'Delta', teamId: 1, kills: 8, deaths: 18, assists: 0, score: 10 },
        ],
        schemaVersion: 1,
    };
}

test('GET /api/health responde con la forma esperada', async () => {
    const ctx = buildCtx();
    await withServer(ctx, async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/health`);
        const body = await res.json();
        assert.ok(['ok', 'degraded', 'down'].includes(body.status));
        assert.strictEqual(body.version, 'test');
        assert.ok(body.checks);
        assert.ok(body.checks.supabase);
        assert.ok(body.checks.whatsapp);
        assert.strictEqual(typeof body.uptimeSec, 'number');
    });
});

test('GET /api/nope -> 404 JSON (no el index.html del SPA)', async () => {
    const ctx = buildCtx();
    await withServer(ctx, async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/nope`);
        assert.strictEqual(res.status, 404);
        const body = await res.json();
        assert.strictEqual(body.error, 'No encontrado');
        assert.strictEqual(body.path, '/api/nope');
    });
});

test('POST /api/report sin X-API-Key -> 401', async () => {
    const ctx = buildCtx();
    await withServer(ctx, async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/report`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(validPayload()),
        });
        assert.strictEqual(res.status, 401);
        const body = await res.json();
        assert.strictEqual(body.error, 'API key inválida');
    });
});

test('POST /api/report con payload inválido -> 400', async () => {
    const ctx = buildCtx();
    await withServer(ctx, async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/report`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-API-Key': 'test-api-key' },
            body: JSON.stringify({ gameData: { gameUniqueId: 'x' }, players: 'no-es-arreglo' }),
        });
        assert.strictEqual(res.status, 400);
        const body = await res.json();
        assert.strictEqual(body.error, 'players debe ser un arreglo');
    });
});

test('POST /api/report camino feliz: processed, saveGame y sendImage en orden', async () => {
    const supabase = makeFakeSupabase();
    const whatsapp = makeFakeWhatsapp({
        isReady() { return true; },
        groupIdFor(format) { return format === '2v2' ? '5215500000000-000@g.us' : null; },
    });
    const discord = makeFakeDiscord();
    const order = [];
    const origDiscordSendImage = discord.sendImage.bind(discord);
    discord.sendImage = async (...args) => { order.push('discord.sendImage'); return origDiscordSendImage(...args); };
    const origSendImage = whatsapp.sendImage.bind(whatsapp);
    whatsapp.sendImage = async (...args) => { order.push('whatsapp.sendImage'); return origSendImage(...args); };
    const origSaveGame = supabase.saveGame.bind(supabase);
    supabase.saveGame = async (...args) => { order.push('supabase.saveGame'); return origSaveGame(...args); };

    const ctx = buildCtx({ supabase, whatsapp, discord });
    await withServer(ctx, async (baseUrl) => {
        const payload = validPayload();
        const res = await fetch(`${baseUrl}/api/report`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-API-Key': 'test-api-key' },
            body: JSON.stringify(payload),
        });
        assert.strictEqual(res.status, 200);
        const body = await res.json();
        assert.strictEqual(body.status, 'processed');
        assert.strictEqual(body.gameId, payload.gameData.gameUniqueId);
        assert.strictEqual(body.format, '2v2');

        assert.strictEqual(supabase.calls.saveGame.length, 1);
        assert.strictEqual(whatsapp.calls.sendImage.length, 1);
        assert.strictEqual(discord.calls.length, 1);
        assert.deepStrictEqual(order, ['discord.sendImage', 'whatsapp.sendImage', 'supabase.saveGame']);
    });
});

test('POST /api/report duplicado (ya existe en Supabase) -> status duplicate', async () => {
    const supabase = makeFakeSupabase();
    const gameId = 'ya-existe-1';
    supabase.existingIds.add(gameId);
    const ctx = buildCtx({ supabase });
    await withServer(ctx, async (baseUrl) => {
        const payload = validPayload({ gameUniqueId: gameId });
        const res = await fetch(`${baseUrl}/api/report`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-API-Key': 'test-api-key' },
            body: JSON.stringify(payload),
        });
        assert.strictEqual(res.status, 200);
        const body = await res.json();
        assert.deepStrictEqual(body, {
            status: 'duplicate',
            gameId,
            message: 'Este juego ya fue procesado anteriormente',
        });
        assert.strictEqual(supabase.calls.saveGame.length, 0);
    });
});

test('POST /api/report partida anulada por el validador -> status voided', async () => {
    const supabase = makeFakeSupabase();
    const ctx = buildCtx({ supabase });
    await withServer(ctx, async (baseUrl) => {
        const payload = validPayload({ gameData: { lastMatchIncomplete: true } });
        const res = await fetch(`${baseUrl}/api/report`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-API-Key': 'test-api-key' },
            body: JSON.stringify(payload),
        });
        assert.strictEqual(res.status, 200);
        const body = await res.json();
        assert.strictEqual(body.status, 'voided');
        assert.strictEqual(body.reason, 'last_match_incomplete');
        assert.strictEqual(body.message, 'Partida anulada; no cuenta para stats');

        assert.strictEqual(supabase.calls.saveGame.length, 1);
        assert.strictEqual(supabase.calls.saveGame[0].meta.isVoided, true);
    });
});

test('POST /api/report 2v2 matchmaking -> status skipped', async () => {
    const supabase = makeFakeSupabase();
    const ctx = buildCtx({ supabase });
    await withServer(ctx, async (baseUrl) => {
        const payload = validPayload({ gameData: { isMatchmaking: true } });
        const res = await fetch(`${baseUrl}/api/report`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-API-Key': 'test-api-key' },
            body: JSON.stringify(payload),
        });
        assert.strictEqual(res.status, 200);
        const body = await res.json();
        assert.deepStrictEqual(body, {
            status: 'skipped',
            gameId: payload.gameData.gameUniqueId,
            message: 'Partida 2v2 de matchmaking ignorada',
        });
        assert.strictEqual(supabase.calls.saveGame.length, 0);
    });
});
