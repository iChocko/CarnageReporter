/**
 * Tests de services/supabase.js saveGame() con un cliente Supabase fake
 * (sin red): el upsert de jugadores debe ir en UN SOLO lote (antes era uno
 * por jugador), con el onConflict correcto, y cualquier error de Supabase
 * debe TRONAR (throw) en vez de devolver false silenciosamente.
 */

const { test } = require('node:test');
const assert = require('assert');

const SupabaseService = require('../services/supabase');

function makeFakeClient({ gamesError = null, playersError = null } = {}) {
    const calls = [];
    const client = {
        from(table) {
            return {
                upsert: async (data, opts) => {
                    calls.push({ table, data, opts });
                    if (table === 'games') return { error: gamesError };
                    if (table === 'players') return { error: playersError };
                    return { error: null };
                },
            };
        },
    };
    return { client, calls };
}

function makeGameData() {
    return {
        gameUniqueId: 'game-1111',
        gameEnum: 0,
        isMatchmaking: false,
        isTeamsEnabled: true,
        hopperName: null,
        gameTypeName: '2V2 HARDCORE TS',
        mapName: 'Guardian',
        timestamp: '2026-06-15T20:00:00.000Z',
        duration: 300,
        playlistName: null,
        lastMatchIncomplete: false,
        partySize: null,
    };
}

function makePlayers() {
    return [
        { xboxUserId: 'x1', gamertag: 'Alfa', teamId: 0, score: 15, kills: 10, deaths: 5 },
        { xboxUserId: 'x2', gamertag: 'Beta', teamId: 0, score: 15, kills: 8, deaths: 6 },
        { xboxUserId: 'x3', gamertag: 'Cyto', teamId: 1, score: 10, kills: 6, deaths: 8 },
        { xboxUserId: 'x4', gamertag: 'Delta', teamId: 1, score: 10, kills: 4, deaths: 9 },
    ];
}

test('sin client (Supabase no configurado) -> false, sin tronar', async () => {
    const svc = new SupabaseService();
    svc.client = null;
    const ok = await svc.saveGame(makeGameData(), makePlayers(), { format: '2v2' });
    assert.strictEqual(ok, false);
});

test('guarda el juego y sube TODOS los jugadores en un solo upsert en lote', async () => {
    const svc = new SupabaseService();
    const { client, calls } = makeFakeClient();
    svc.client = client;

    const ok = await svc.saveGame(makeGameData(), makePlayers(), { format: '2v2', schemaVersion: 2 });
    assert.strictEqual(ok, true);

    const gameCalls = calls.filter(c => c.table === 'games');
    const playerCalls = calls.filter(c => c.table === 'players');
    assert.strictEqual(gameCalls.length, 1);
    assert.strictEqual(playerCalls.length, 1, 'debe ser UN SOLO upsert para todos los jugadores, no uno por jugador');

    const [playerCall] = playerCalls;
    assert.strictEqual(playerCall.data.length, 4);
    assert.deepStrictEqual(playerCall.opts, { onConflict: 'game_unique_id,xbox_user_id', ignoreDuplicates: true });

    const row = playerCall.data.find(r => r.gamertag === 'Alfa');
    assert.strictEqual(row.game_unique_id, 'game-1111');
    assert.strictEqual(row.xbox_user_id, 'x1');
    assert.strictEqual(row.kd_ratio, 2); // 10 kills / 5 deaths
});

test('sin jugadores: guarda el juego pero no llama upsert de jugadores', async () => {
    const svc = new SupabaseService();
    const { client, calls } = makeFakeClient();
    svc.client = client;

    const ok = await svc.saveGame(makeGameData(), [], { format: '2v2' });
    assert.strictEqual(ok, true);
    assert.strictEqual(calls.filter(c => c.table === 'games').length, 1);
    assert.strictEqual(calls.filter(c => c.table === 'players').length, 0);
});

test('el upsert del juego falla -> saveGame TRUENA (throw), no regresa false', async () => {
    const svc = new SupabaseService();
    const { client } = makeFakeClient({ gamesError: { message: 'conexión perdida' } });
    svc.client = client;

    await assert.rejects(
        () => svc.saveGame(makeGameData(), makePlayers(), { format: '2v2' }),
        /Error guardando juego/
    );
});

test('el upsert de jugadores falla -> saveGame TRUENA (throw), no regresa false', async () => {
    const svc = new SupabaseService();
    const { client } = makeFakeClient({ playersError: { message: 'constraint violada' } });
    svc.client = client;

    await assert.rejects(
        () => svc.saveGame(makeGameData(), makePlayers(), { format: '2v2' }),
        /Error guardando jugadores/
    );
});
