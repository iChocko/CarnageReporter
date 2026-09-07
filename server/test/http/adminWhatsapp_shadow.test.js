/**
 * Tests de las rutas admin de WhatsApp nuevas en Fase A5: `?transport=shadow`
 * en GET /qr y /status, y POST /pairing-code. Fakes mínimos (sin Baileys ni
 * whatsapp-web.js reales); mismo patrón que admin_republish.test.js
 * (createApp + servidor HTTP real en un puerto efímero).
 */

'use strict';

const { test } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createApp } = require('../../app');
const { createGamesCache } = require('../../domain/gamesCache');
const { makeLock } = require('../../state/locks');
const { logger } = require('../../logger');

function fakeSupabase() {
    return {
        client: null,
        async getAllValidGamesWithPlayers() { return []; },
        async getRecentGamesWithPlayers() { return []; },
    };
}

function makePrimaryWhatsapp(overrides = {}) {
    return {
        enabled: true,
        transport: 'wwebjs',
        getQR: () => null,
        getStatus: () => ({ status: 'ready', transport: 'wwebjs', groups: {}, configured: {} }),
        async requestPairingCode() { throw new Error('requestPairingCode() no soportado por este transporte'); },
        ...overrides,
    };
}

function buildCtx({ whatsapp, shadow } = {}) {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-whatsapp-shadow-'));
    const supabase = fakeSupabase();
    const primary = whatsapp || makePrimaryWhatsapp();
    if (shadow) primary.shadow = shadow;
    return {
        config: {
            API_KEY: 'test-api-key', ADMIN_KEY: 'test-admin-key', STRIPE_SECRET_KEY: null,
            CORS_ORIGIN: null, LEADERBOARD_MIN_GAMES: '5', WHATSAPP_ADMIN_JIDS: '',
        },
        logger,
        supabase,
        whatsapp: primary,
        discord: {},
        discord4v4: {},
        renderer: {},
        alerts: { alert: async () => false },
        outputDir,
        gamesCache: createGamesCache({ supabase, ttlMs: 60_000 }),
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

const ADMIN_HEADERS = { 'X-Admin-Key': 'test-admin-key' };

console.log('\n— GET /api/admin/whatsapp/status —');

test('sin ?transport devuelve el status del puerto primario', async () => {
    const ctx = buildCtx();
    await withServer(ctx, async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/admin/whatsapp/status`, { headers: ADMIN_HEADERS });
        const body = await res.json();
        assert.strictEqual(res.status, 200);
        assert.strictEqual(body.transport, 'wwebjs');
    });
});

test('?transport=shadow devuelve el status del shadow cuando está configurado', async () => {
    const shadow = { getStatus: () => ({ status: 'ready', transport: 'baileys', groups: {}, configured: {} }) };
    const ctx = buildCtx({ shadow });
    await withServer(ctx, async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/admin/whatsapp/status?transport=shadow`, { headers: ADMIN_HEADERS });
        const body = await res.json();
        assert.strictEqual(res.status, 200);
        assert.strictEqual(body.transport, 'baileys');
    });
});

test('?transport=shadow sin shadow configurado -> 404', async () => {
    const ctx = buildCtx();
    await withServer(ctx, async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/admin/whatsapp/status?transport=shadow`, { headers: ADMIN_HEADERS });
        assert.strictEqual(res.status, 404);
    });
});

console.log('\n— GET /api/admin/whatsapp/qr —');

test('?transport=shadow pide el QR al shadow, no al primario', async () => {
    const primaryQrCalls = [];
    const whatsapp = makePrimaryWhatsapp({ getQR: () => { primaryQrCalls.push(1); return null; } });
    const shadow = { getQR: () => null };
    const ctx = buildCtx({ whatsapp, shadow });
    await withServer(ctx, async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/admin/whatsapp/qr?transport=shadow`, { headers: ADMIN_HEADERS });
        assert.strictEqual(res.status, 204);
        assert.strictEqual(primaryQrCalls.length, 0, 'no debió consultar el QR del primario');
    });
});

console.log('\n— POST /api/admin/whatsapp/pairing-code —');

test('sin phone -> 400', async () => {
    const ctx = buildCtx();
    await withServer(ctx, async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/admin/whatsapp/pairing-code`, {
            method: 'POST', headers: { ...ADMIN_HEADERS, 'Content-Type': 'application/json' }, body: JSON.stringify({}),
        });
        assert.strictEqual(res.status, 400);
    });
});

test('pide el pairing code al primario por default', async () => {
    const whatsapp = makePrimaryWhatsapp({ requestPairingCode: async (digits) => `CODE-${digits}` });
    const ctx = buildCtx({ whatsapp });
    await withServer(ctx, async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/admin/whatsapp/pairing-code`, {
            method: 'POST',
            headers: { ...ADMIN_HEADERS, 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone: '+52 155 0000 0000' }),
        });
        const body = await res.json();
        assert.strictEqual(res.status, 200);
        assert.strictEqual(body.pairingCode, 'CODE-5215500000000');
    });
});

test('con transport:"shadow" pide el pairing code al shadow', async () => {
    const shadow = { requestPairingCode: async (digits) => `SHADOW-${digits}` };
    const ctx = buildCtx({ shadow });
    await withServer(ctx, async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/admin/whatsapp/pairing-code`, {
            method: 'POST',
            headers: { ...ADMIN_HEADERS, 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone: '5215500000000', transport: 'shadow' }),
        });
        const body = await res.json();
        assert.strictEqual(res.status, 200);
        assert.strictEqual(body.pairingCode, 'SHADOW-5215500000000');
    });
});

test('transport:"shadow" sin shadow configurado -> 404', async () => {
    const ctx = buildCtx();
    await withServer(ctx, async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/admin/whatsapp/pairing-code`, {
            method: 'POST',
            headers: { ...ADMIN_HEADERS, 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone: '5215500000000', transport: 'shadow' }),
        });
        assert.strictEqual(res.status, 404);
    });
});

test('sin X-Admin-Key -> 401', async () => {
    const ctx = buildCtx();
    await withServer(ctx, async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/admin/whatsapp/status`);
        assert.strictEqual(res.status, 401);
    });
});
