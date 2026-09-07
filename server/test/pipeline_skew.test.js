/**
 * Tests de server/report/pipeline.js (Fase B3): corrección del timestamp de
 * la partida usando el desfase de reloj del cliente (clientSentAt - hora del
 * servidor) para payloads schemaVersion >= 3, y que el clamp clásico (v1/v2,
 * o cualquier timestamp que siga en el futuro tras el ajuste) se conserve.
 */

const { test } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { processReport } = require('../report/pipeline');
const { createGamesCache } = require('../domain/gamesCache');

function makeFakeSupabase() {
    const existingIds = new Set();
    const calls = { saveGame: [] };
    return {
        calls,
        async gameExists(id) { return existingIds.has(id); },
        async saveGame(gameData, players, meta) {
            calls.saveGame.push({ gameData: { ...gameData }, players, meta });
            existingIds.add(gameData.gameUniqueId);
        },
    };
}

function buildCtx(overrides = {}) {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-skew-test-'));
    const supabase = overrides.supabase || makeFakeSupabase();
    return {
        supabase,
        renderer: { async generatePNG(gameData, players, pngPath) { fs.writeFileSync(pngPath, Buffer.from([0])); } },
        discord: { async sendImage() { return true; } },
        discord4v4: { async sendImage() { return true; } },
        whatsapp: { isReady() { return false; }, getStatus() { return { status: 'disconnected' }; }, groupIdFor() { return null; } },
        alerts: { alert: async () => false },
        outputDir,
        gamesCache: createGamesCache({ supabase }),
    };
}

function basePayload(overrides = {}) {
    return {
        gameData: {
            gameUniqueId: `game-${Math.random().toString(36).slice(2)}`,
            mapCode: 'asq_guardia',
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
        filename: 'f.xml',
        schemaVersion: overrides.schemaVersion ?? 3,
        clientVersion: '1.7.0',
        installId: overrides.installId ?? null,
        clientSentAt: overrides.clientSentAt,
    };
}

console.log('\n— pipeline: desfase de reloj (schemaVersion 3) —');

test('cliente adelantado 10 min: el timestamp de la partida se corrige hacia atrás', async () => {
    const supabase = makeFakeSupabase();
    const ctx = buildCtx({ supabase });

    const realGameTime = new Date(Date.now() - 5 * 60 * 1000); // la partida "de verdad" terminó hace 5 min
    const skewMs = 10 * 60 * 1000; // el reloj del cliente está 10 min adelantado
    const clientSentAt = new Date(Date.now() + skewMs).toISOString();

    const payload = basePayload({
        gameData: { timestamp: realGameTime.toISOString() },
        clientSentAt,
    });

    const result = await processReport(payload, ctx);
    assert.strictEqual(result.status, 'processed');

    const saved = supabase.calls.saveGame[0].gameData;
    const savedMs = new Date(saved.timestamp).getTime();
    // timestamp corregido = original - skew = 5 min antes de "ahora" - 10 min adelanto = ~15 min en el pasado
    const expectedMs = realGameTime.getTime() - skewMs;
    assert.ok(Math.abs(savedMs - expectedMs) < 3000, `esperaba ~${new Date(expectedMs).toISOString()}, quedó ${saved.timestamp}`);
});

test('desfase pequeño (30s, bajo el umbral de 2 min) no toca el timestamp', async () => {
    const supabase = makeFakeSupabase();
    const ctx = buildCtx({ supabase });

    const originalTs = new Date(Date.now() - 60 * 1000).toISOString();
    const clientSentAt = new Date(Date.now() + 30 * 1000).toISOString(); // 30s adelantado

    const payload = basePayload({ gameData: { timestamp: originalTs }, clientSentAt });
    await processReport(payload, ctx);

    const saved = supabase.calls.saveGame[0].gameData;
    assert.strictEqual(saved.timestamp, originalTs);
});

test('el ajuste que aun así deja el timestamp en el futuro cae al clamp final (hora del servidor)', async () => {
    const supabase = makeFakeSupabase();
    const ctx = buildCtx({ supabase });

    // Cliente MUY atrasado (reloj -20 min): clientSentAt queda 20 min en el
    // pasado, así que el "ajuste" empujaría el timestamp hacia el FUTURO.
    const originalTs = new Date(Date.now() + 15 * 60 * 1000).toISOString(); // ya venía raro (15 min futuro)
    const clientSentAt = new Date(Date.now() - 20 * 60 * 1000).toISOString();

    const payload = basePayload({ gameData: { timestamp: originalTs }, clientSentAt });
    const before = Date.now();
    await processReport(payload, ctx);
    const after = Date.now();

    const saved = supabase.calls.saveGame[0].gameData;
    const savedMs = new Date(saved.timestamp).getTime();
    assert.ok(savedMs >= before - 1000 && savedMs <= after + 1000, `esperaba ~ahora, quedó ${saved.timestamp}`);
});

test('schemaVersion 1/2 (sin clientSentAt): se conserva el clamp clásico (futuro -> hora del servidor)', async () => {
    const supabase = makeFakeSupabase();
    const ctx = buildCtx({ supabase });

    const futureTs = new Date(Date.now() + 20 * 60 * 1000).toISOString();
    const payload = basePayload({ gameData: { timestamp: futureTs }, schemaVersion: 1, clientSentAt: undefined });
    delete payload.installId;

    const before = Date.now();
    await processReport(payload, ctx);
    const after = Date.now();

    const saved = supabase.calls.saveGame[0].gameData;
    const savedMs = new Date(saved.timestamp).getTime();
    assert.ok(savedMs >= before - 1000 && savedMs <= after + 1000);
});

test('schemaVersion 3 pero clientSentAt ausente: no truena, se comporta como v1/v2', async () => {
    const supabase = makeFakeSupabase();
    const ctx = buildCtx({ supabase });

    const normalTs = new Date(Date.now() - 60 * 1000).toISOString();
    const payload = basePayload({ gameData: { timestamp: normalTs }, clientSentAt: undefined });

    await processReport(payload, ctx);

    const saved = supabase.calls.saveGame[0].gameData;
    assert.strictEqual(saved.timestamp, normalTs);
});

test('clientSentAt inválido (no parseable) no truena, ignora el ajuste', async () => {
    const supabase = makeFakeSupabase();
    const ctx = buildCtx({ supabase });

    const normalTs = new Date(Date.now() - 60 * 1000).toISOString();
    const payload = basePayload({ gameData: { timestamp: normalTs }, clientSentAt: 'no-es-una-fecha' });

    await processReport(payload, ctx);

    const saved = supabase.calls.saveGame[0].gameData;
    assert.strictEqual(saved.timestamp, normalTs);
});

console.log('\n— pipeline: saveGame recibe installId/clientSentAt en meta —');

test('installId y clientSentAt llegan a saveGame en el objeto meta', async () => {
    const supabase = makeFakeSupabase();
    const ctx = buildCtx({ supabase });

    const clientSentAt = new Date().toISOString();
    const payload = basePayload({ installId: 'install-xyz', clientSentAt });

    await processReport(payload, ctx);

    const meta = supabase.calls.saveGame[0].meta;
    assert.strictEqual(meta.installId, 'install-xyz');
    assert.strictEqual(meta.clientSentAt, clientSentAt);
});
