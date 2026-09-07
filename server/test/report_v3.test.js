/**
 * Tests de integración de POST /api/report para la Fase B3 (identidad de
 * instalación y hora del cliente): instalaciones revocadas, versión mínima
 * de cliente, validación de installId/clientSentAt, y que saveGame reciba
 * esos campos. Mismo patrón de fakes que app.test.js, reducido a lo que
 * hace falta aquí.
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

function fakeSupabaseClient() {
    return { from() { return { select() { return { limit() { return Promise.resolve({ data: [], error: null }); } }; } }; } };
}

function makeFakeSupabase() {
    const existingIds = new Set();
    const calls = { saveGame: [] };
    return {
        client: fakeSupabaseClient(),
        calls,
        async gameExists(id) { return existingIds.has(id); },
        async saveGame(gameData, players, meta) {
            calls.saveGame.push({ gameData: { ...gameData }, players, meta });
            existingIds.add(gameData.gameUniqueId);
        },
        async getAllValidGamesWithPlayers() { return []; },
        async getRecentGamesWithPlayers() { return []; },
        async findGamesByIdPrefix() { return []; },
        async deleteGame() { },
        async setVoided() { },
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
        registerCommand() { },
        setAlertHandler() { },
    };
}

function makeFakeDiscord() {
    return { async sendImage() { return true; } };
}

function makeFakeRenderer() {
    return {
        async generatePNG(gameData, players, pngPath) {
            fs.writeFileSync(pngPath, Buffer.from([0]));
        },
    };
}

function buildCtx(configOverrides = {}, ctxOverrides = {}) {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'report-v3-test-'));
    const supabase = ctxOverrides.supabase || makeFakeSupabase();
    const gamesCache = createGamesCache({ supabase });
    return {
        config: {
            API_KEY: 'test-api-key',
            ADMIN_KEY: 'test-admin-key',
            STRIPE_SECRET_KEY: null,
            CORS_ORIGIN: null,
            LEADERBOARD_MIN_GAMES: '5',
            WHATSAPP_ADMIN_JIDS: '',
            REVOKED_INSTALL_IDS: [],
            CLIENT_MIN_VERSION: null,
            ...configOverrides,
        },
        logger,
        supabase,
        whatsapp: ctxOverrides.whatsapp || makeFakeWhatsapp(),
        discord: ctxOverrides.discord || makeFakeDiscord(),
        discord4v4: ctxOverrides.discord4v4 || makeFakeDiscord(),
        renderer: ctxOverrides.renderer || makeFakeRenderer(),
        alerts: ctxOverrides.alerts || { alert: async () => false },
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
        schemaVersion: 3,
        clientVersion: '1.7.0',
        installId: overrides.installId !== undefined ? overrides.installId : 'install-uuid-1',
        clientSentAt: overrides.clientSentAt !== undefined ? overrides.clientSentAt : new Date().toISOString(),
    };
}

console.log('\n— POST /api/report: schemaVersion 3 camino feliz —');

test('acepta schemaVersion 3 con installId/clientSentAt y los guarda en meta', async () => {
    const supabase = makeFakeSupabase();
    const ctx = buildCtx({}, { supabase });
    await withServer(ctx, async (baseUrl) => {
        const payload = validPayload();
        const res = await fetch(`${baseUrl}/api/report`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json', 'X-API-Key': 'test-api-key',
                'X-Install-Id': 'install-uuid-1', 'User-Agent': 'CarnageReporter/1.7.0'
            },
            body: JSON.stringify(payload),
        });
        assert.strictEqual(res.status, 200);
        const body = await res.json();
        assert.strictEqual(body.status, 'processed');

        assert.strictEqual(supabase.calls.saveGame.length, 1);
        assert.strictEqual(supabase.calls.saveGame[0].meta.installId, 'install-uuid-1');
        assert.strictEqual(supabase.calls.saveGame[0].meta.clientSentAt, payload.clientSentAt);
        assert.strictEqual(supabase.calls.saveGame[0].meta.schemaVersion, 3);
    });
});

console.log('\n— POST /api/report: instalación revocada —');

test('installId en REVOKED_INSTALL_IDS -> 403 status revoked, no toca la BD', async () => {
    const supabase = makeFakeSupabase();
    const ctx = buildCtx({ REVOKED_INSTALL_IDS: ['bad-install'] }, { supabase });
    await withServer(ctx, async (baseUrl) => {
        const payload = validPayload({ installId: 'bad-install' });
        const res = await fetch(`${baseUrl}/api/report`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-API-Key': 'test-api-key', 'X-Install-Id': 'bad-install' },
            body: JSON.stringify(payload),
        });
        assert.strictEqual(res.status, 403);
        const body = await res.json();
        assert.strictEqual(body.status, 'revoked');
        assert.strictEqual(body.error, 'Instalación revocada');
        assert.strictEqual(supabase.calls.saveGame.length, 0);
    });
});

test('installId que NO está en la lista de revocados sigue funcionando', async () => {
    const ctx = buildCtx({ REVOKED_INSTALL_IDS: ['otro-instalado'] });
    await withServer(ctx, async (baseUrl) => {
        const payload = validPayload({ installId: 'install-uuid-1' });
        const res = await fetch(`${baseUrl}/api/report`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-API-Key': 'test-api-key', 'X-Install-Id': 'install-uuid-1' },
            body: JSON.stringify(payload),
        });
        assert.strictEqual(res.status, 200);
    });
});

console.log('\n— POST /api/report: versión mínima de cliente —');

test('clientVersion por debajo de CLIENT_MIN_VERSION -> 426 upgrade_required', async () => {
    const ctx = buildCtx({ CLIENT_MIN_VERSION: '2.0.0' });
    await withServer(ctx, async (baseUrl) => {
        const payload = validPayload();
        payload.clientVersion = '1.7.0';
        const res = await fetch(`${baseUrl}/api/report`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-API-Key': 'test-api-key' },
            body: JSON.stringify(payload),
        });
        assert.strictEqual(res.status, 426);
        const body = await res.json();
        assert.strictEqual(body.status, 'upgrade_required');
        assert.strictEqual(body.minVersion, '2.0.0');
    });
});

test('clientVersion en o por encima de CLIENT_MIN_VERSION sigue funcionando', async () => {
    const ctx = buildCtx({ CLIENT_MIN_VERSION: '1.7.0' });
    await withServer(ctx, async (baseUrl) => {
        const payload = validPayload();
        payload.clientVersion = '1.7.0';
        const res = await fetch(`${baseUrl}/api/report`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-API-Key': 'test-api-key' },
            body: JSON.stringify(payload),
        });
        assert.strictEqual(res.status, 200);
    });
});

test('sin clientVersion y CLIENT_MIN_VERSION configurado -> se asume 0.0.0 -> 426', async () => {
    const ctx = buildCtx({ CLIENT_MIN_VERSION: '1.0.0' });
    await withServer(ctx, async (baseUrl) => {
        const payload = validPayload();
        delete payload.clientVersion;
        const res = await fetch(`${baseUrl}/api/report`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-API-Key': 'test-api-key' },
            body: JSON.stringify(payload),
        });
        assert.strictEqual(res.status, 426);
    });
});

test('sin clientVersion y CLIENT_MIN_VERSION SIN configurar -> no se rechaza (compat v1/v2)', async () => {
    const ctx = buildCtx({ CLIENT_MIN_VERSION: null });
    await withServer(ctx, async (baseUrl) => {
        const payload = validPayload();
        delete payload.clientVersion;
        delete payload.installId;
        delete payload.clientSentAt;
        payload.schemaVersion = 1;
        const res = await fetch(`${baseUrl}/api/report`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-API-Key': 'test-api-key' },
            body: JSON.stringify(payload),
        });
        assert.strictEqual(res.status, 200);
    });
});

console.log('\n— POST /api/report: validación de installId/clientSentAt —');

test('installId como número (no string) -> 400', async () => {
    const ctx = buildCtx();
    await withServer(ctx, async (baseUrl) => {
        const payload = validPayload({ installId: 12345 });
        const res = await fetch(`${baseUrl}/api/report`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-API-Key': 'test-api-key' },
            body: JSON.stringify(payload),
        });
        assert.strictEqual(res.status, 400);
        const body = await res.json();
        assert.strictEqual(body.error, 'installId inválido');
    });
});

test('installId de más de 64 caracteres -> 400', async () => {
    const ctx = buildCtx();
    await withServer(ctx, async (baseUrl) => {
        const payload = validPayload({ installId: 'x'.repeat(65) });
        const res = await fetch(`${baseUrl}/api/report`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-API-Key': 'test-api-key' },
            body: JSON.stringify(payload),
        });
        assert.strictEqual(res.status, 400);
    });
});

test('clientSentAt de más de 64 caracteres -> 400', async () => {
    const ctx = buildCtx();
    await withServer(ctx, async (baseUrl) => {
        const payload = validPayload({ clientSentAt: 'x'.repeat(65) });
        const res = await fetch(`${baseUrl}/api/report`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-API-Key': 'test-api-key' },
            body: JSON.stringify(payload),
        });
        assert.strictEqual(res.status, 400);
    });
});

test('sin installId ni clientSentAt (cliente v1/v2 legado) sigue aceptándose', async () => {
    const ctx = buildCtx();
    await withServer(ctx, async (baseUrl) => {
        const payload = validPayload();
        delete payload.installId;
        delete payload.clientSentAt;
        payload.schemaVersion = 1;
        const res = await fetch(`${baseUrl}/api/report`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-API-Key': 'test-api-key' },
            body: JSON.stringify(payload),
        });
        assert.strictEqual(res.status, 200);
    });
});
