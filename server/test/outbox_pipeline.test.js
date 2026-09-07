/**
 * Tests de server/report/pipeline.js para la Fase A4 ("guardar primero +
 * outbox persistente"): saveGame corre ANTES de render/publicar, un fallo de
 * render DESPUÉS de guardar sigue alertando y no publica nada, y con
 * OUTBOX_ENABLED=true la publicación se encola (con fallback a directo si la
 * tabla `outbox` no existe todavía) en vez de mandarse aquí mismo.
 */

'use strict';

const { test } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { processReport } = require('../report/pipeline');
const { createGamesCache } = require('../domain/gamesCache');
const { createAlerts } = require('../alerts');
const { OutboxUnavailableError } = require('../messaging/outboxStore');

function makeFakeSupabase() {
    const existingIds = new Set();
    const calls = { saveGame: [], gameExists: [] };
    return {
        calls,
        existingIds,
        async gameExists(id) { calls.gameExists.push(id); return existingIds.has(id); },
        async saveGame(gameData, players, meta) {
            calls.saveGame.push({ gameData: { ...gameData }, players, meta });
            existingIds.add(gameData.gameUniqueId);
        },
        async getAllValidGamesWithPlayers() { return []; },
        async getRecentGamesWithPlayers() { return []; },
    };
}

function makeFakeWhatsapp(overrides = {}) {
    const calls = { sendImage: [], sendMessage: [] };
    return {
        calls,
        isReady() { return true; },
        getStatus() { return { status: 'ready' }; },
        groupIdFor(format) { return format === '2v2' ? '5215500000000-000@g.us' : null; },
        async sendImage(imagePath, caption, chatId) { calls.sendImage.push({ imagePath, caption, chatId }); return true; },
        async sendMessage(text, chatId, options) { calls.sendMessage.push({ text, chatId, options }); return true; },
        ...overrides,
    };
}

function makeFakeDiscord() {
    const calls = [];
    return { calls, async sendImage(pngPath, gameData, players) { calls.push({ pngPath, gameData, players }); return true; } };
}

function makeFakeRenderer(overrides = {}) {
    return {
        lastOkAt: null,
        async generatePNG(gameData, players, pngPath) {
            fs.writeFileSync(pngPath, Buffer.from([0]));
            this.lastOkAt = new Date().toISOString();
        },
        ...overrides,
    };
}

/** Store de outbox en memoria: enqueue simple, opcionalmente forzado a "no disponible". */
function makeFakeOutboxStore({ unavailable = false } = {}) {
    const rows = [];
    let nextId = 1;
    return {
        rows,
        async enqueue(row) {
            if (unavailable) throw new OutboxUnavailableError('tabla outbox no existe (fake)');
            const stored = { id: nextId++, status: 'pending', attempts: 0, ...row };
            rows.push(stored);
            return { id: stored.id, created: true };
        },
    };
}

function buildCtx(overrides = {}) {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'outbox-pipeline-test-'));
    const supabase = overrides.supabase || makeFakeSupabase();
    const alerts = overrides.alerts || { alert: async () => false };
    const ctx = {
        config: { OUTBOX_ENABLED: false, ...overrides.config },
        supabase,
        renderer: overrides.renderer || makeFakeRenderer(),
        discord: overrides.discord || makeFakeDiscord(),
        discord4v4: overrides.discord4v4 || makeFakeDiscord(),
        whatsapp: overrides.whatsapp || makeFakeWhatsapp(),
        alerts,
        outputDir,
        gamesCache: createGamesCache({ supabase }),
    };
    if (overrides.outboxStore) {
        ctx.outboxStore = overrides.outboxStore;
        ctx.outboxWorker = overrides.outboxWorker || { kick() {} };
    }
    return ctx;
}

function validInput(overrides = {}) {
    return {
        gameData: {
            gameUniqueId: overrides.gameUniqueId || `game-${Math.random().toString(36).slice(2)}`,
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

console.log('\n— pipeline: save-first (Fase A4) —');

test('saveGame corre ANTES de render y de publicar (orden)', async () => {
    const order = [];
    const supabase = makeFakeSupabase();
    const origSave = supabase.saveGame.bind(supabase);
    supabase.saveGame = async (...args) => { order.push('saveGame'); return origSave(...args); };

    const renderer = makeFakeRenderer();
    const origRender = renderer.generatePNG.bind(renderer);
    renderer.generatePNG = async (...args) => { order.push('generatePNG'); return origRender(...args); };

    const discord = makeFakeDiscord();
    const origDiscord = discord.sendImage.bind(discord);
    discord.sendImage = async (...args) => { order.push('discord.sendImage'); return origDiscord(...args); };

    const whatsapp = makeFakeWhatsapp();
    const origWa = whatsapp.sendImage.bind(whatsapp);
    whatsapp.sendImage = async (...args) => { order.push('whatsapp.sendImage'); return origWa(...args); };

    const ctx = buildCtx({ supabase, renderer, discord, whatsapp });
    const result = await processReport(validInput(), ctx);

    assert.strictEqual(result.status, 'processed');
    assert.deepStrictEqual(order, ['saveGame', 'generatePNG', 'discord.sendImage', 'whatsapp.sendImage']);
});

test('el render truena DESPUÉS de guardar -> processReport rechaza, alerta y NO publica', async () => {
    const supabase = makeFakeSupabase();
    const renderer = makeFakeRenderer({ async generatePNG() { throw new Error('boom: disco lleno'); } });
    const discord = makeFakeDiscord();
    const alertCalls = [];
    const alerts = { alert: async (level, text, opts) => { alertCalls.push({ level, text, opts }); return true; } };

    const ctx = buildCtx({ supabase, renderer, discord, alerts });
    const input = validInput();

    await assert.rejects(() => processReport(input, ctx), /boom: disco lleno/);

    // El juego SÍ quedó guardado (save-first)...
    assert.strictEqual(supabase.calls.saveGame.length, 1);
    // ...pero nada se publicó tras el fallo de render.
    assert.strictEqual(discord.calls.length, 0);
    // Y se avisó por el canal de alertas con la key del juego.
    assert.strictEqual(alertCalls.length, 1);
    assert.strictEqual(alertCalls[0].opts.key, `report:${input.gameData.gameUniqueId}`);
    assert.match(alertCalls[0].text, /falló DESPUÉS de guardarse en Supabase/);
});

console.log('\n— pipeline: OUTBOX_ENABLED=true —');

test('con el outbox prendido, se encolan discord/whatsapp/round_update y la respuesta trae publish', async () => {
    const supabase = makeFakeSupabase();
    const discord = makeFakeDiscord();
    const whatsapp = makeFakeWhatsapp();
    const outboxStore = makeFakeOutboxStore();

    const ctx = buildCtx({ supabase, discord, whatsapp, outboxStore, config: { OUTBOX_ENABLED: true } });
    const input = validInput();
    const result = await processReport(input, ctx);

    assert.strictEqual(result.status, 'processed');
    assert.strictEqual(result.format, '2v2');
    assert.deepStrictEqual(result.publish, { discord: 'queued', whatsapp: 'queued' });

    // Nada se mandó DIRECTO: todo quedó encolado.
    assert.strictEqual(discord.calls.length, 0);
    assert.strictEqual(whatsapp.calls.sendImage.length, 0);

    const kinds = outboxStore.rows.map(r => `${r.kind}:${r.channel}`).sort();
    assert.deepStrictEqual(kinds, ['game_image:discord', 'game_image:whatsapp', 'round_update:whatsapp']);

    const discordRow = outboxStore.rows.find(r => r.channel === 'discord');
    assert.strictEqual(discordRow.dedupe_key, `game_image:discord:${input.gameData.gameUniqueId}`);
    assert.strictEqual(discordRow.payload.gameId, input.gameData.gameUniqueId);
    assert.ok(discordRow.payload.gameData);
    assert.ok(discordRow.payload.players);

    const waRow = outboxStore.rows.find(r => r.channel === 'whatsapp' && r.kind === 'game_image');
    assert.strictEqual(waRow.dedupe_key, `game_image:whatsapp:${input.gameData.gameUniqueId}`);
    assert.ok(typeof waRow.payload.caption === 'string' && waRow.payload.caption.length > 0);
});

test('con el outbox prendido, sin grupo de WhatsApp configurado para el formato -> whatsapp:"skipped"', async () => {
    const supabase = makeFakeSupabase();
    const whatsapp = makeFakeWhatsapp({ groupIdFor() { return null; } });
    const outboxStore = makeFakeOutboxStore();
    const ctx = buildCtx({ supabase, whatsapp, outboxStore, config: { OUTBOX_ENABLED: true } });

    const result = await processReport(validInput(), ctx);
    assert.strictEqual(result.publish.whatsapp, 'skipped');
    assert.strictEqual(outboxStore.rows.some(r => r.channel === 'whatsapp' && r.kind === 'game_image'), false);
});

console.log('\n— pipeline: outbox no disponible (fallback a directo) —');

test('tabla outbox faltante -> fallback a publicación directa + UNA sola alerta', async () => {
    const supabase = makeFakeSupabase();
    const discord = makeFakeDiscord();
    const whatsapp = makeFakeWhatsapp();
    const outboxStore = makeFakeOutboxStore({ unavailable: true });
    const alertSends = [];
    const alertDiscord = { async sendMessage(text) { alertSends.push(text); return true; } }; // nunca toca la red real
    const alerts = createAlerts(alertDiscord);

    const ctx = buildCtx({ supabase, discord, whatsapp, outboxStore, alerts, config: { OUTBOX_ENABLED: true } });
    const result = await processReport(validInput(), ctx);

    assert.strictEqual(result.status, 'processed');
    // Fallback: SÍ se publicó directo (discord + whatsapp), como si el outbox estuviera apagado.
    assert.strictEqual(discord.calls.length, 1);
    assert.strictEqual(whatsapp.calls.sendImage.length, 1);
    assert.deepStrictEqual(result.publish, { discord: 'sent', whatsapp: 'sent' });
    // 3 intentos de encolar (discord/whatsapp/round_update) fallan por la misma
    // causa, pero el cooldown de alerts.js (key 'outbox:unavailable') solo deja pasar UNO.
    assert.strictEqual(alertSends.length, 1, `se esperaba 1 alerta, hubo ${alertSends.length}: ${JSON.stringify(alertSends)}`);
});
