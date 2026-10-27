/**
 * Tests de integración del torneo: GET /api/stats/torneo (público) y el
 * panel /api/admin/torneo/* (ADMIN_KEY o TORNEO_ADMIN_KEY), más la línea
 * del caption (domain/torneo.captionLineFor). Mismo patrón que
 * stats_dashboard.test.js: createApp con dependencias falsas.
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
const torneo = require('../domain/torneo');
const seed = require('../torneos/leyendas-oxidadas-2.json');

const TOMM = ['SSTomm', 'M4ST3RWARS', 'Legitbox', 'PrimalNewt9929'];
const SHINE = ['iShinedownN', 'Shady Legacyy', 'SsMecoboy', 'hydracoin'];

function g(id, map, type, scoreTomm, scoreShine, minutes) {
    const mk = (tags, team, score) => tags.map((gamertag, i) => ({
        gamertag, team_id: team, score: i === 0 ? score : 0, kills: 10, deaths: 8, assists: 2,
        most_kills_in_a_row: 3, completed_game: 1,
    }));
    return {
        game_unique_id: id, map_name: map, game_type_name: type,
        timestamp: new Date(Date.parse('2026-10-27T21:00:00-06:00') + minutes * 60_000).toISOString(),
        duration: 600, format: '4v4', is_voided: false, void_reason: null,
        players: [...mk(TOMM, 0, scoreTomm), ...mk(SHINE, 1, scoreShine)],
    };
}

function buildCtx({ games = [], withConfig = true } = {}) {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'torneo-'));
    if (withConfig) fs.writeFileSync(path.join(outputDir, 'torneo.json'), JSON.stringify(seed));
    const supabase = {
        client: null,
        async getAllValidGamesWithPlayers() { return []; },
        async getRecentGamesWithPlayers() { return []; },
        async getGamesWithPlayersSince() { return games; },
        async getGameWithPlayers() { return null; },
        async findGamesByIdPrefix(prefix) {
            return games.filter(x => x.game_unique_id.startsWith(prefix)).map(x => ({ game_unique_id: x.game_unique_id }));
        },
        getProcessedCount() { return 0; },
    };
    return {
        config: {
            API_KEY: 'k', ADMIN_KEY: 'test-admin-key', TORNEO_ADMIN_KEY: 'test-torneo-key',
            CORS_ORIGIN: null, WHATSAPP_ADMIN_JIDS: '',
        },
        logger,
        supabase,
        whatsapp: {
            enabled: false, isReady: () => false, getStatus: () => ({ status: 'disconnected' }),
            groupIdFor: () => null, registerCommand() {}, setAlertHandler() {},
            async resolveLidPn(j) { return j.map(() => ({})); },
        },
        discord: {}, discord4v4: {}, renderer: {},
        alerts: { alert: async () => false },
        outputDir,
        gamesCache: createGamesCache({ supabase, ttlMs: 60_000 }),
        locks: {
            withRosterLock: makeLock(), withForfeitLock: makeLock(), withAnularLock: makeLock(),
            withAjusteLock: makeLock(), withSaldosLock: makeLock(), withTorneoLock: makeLock(),
        },
        version: 'test',
        getSchedulerJobs: () => [],
    };
}

async function withServer(ctx, fn) {
    const server = createApp(ctx).listen(0, '127.0.0.1');
    await new Promise(r => server.once('listening', r));
    try {
        await fn(`http://127.0.0.1:${server.address().port}`);
    } finally {
        await new Promise(r => server.close(r));
    }
}

const json = (method, body, key) => ({
    method,
    headers: { 'content-type': 'application/json', ...(key ? { 'x-admin-key': key } : {}) },
    body: body ? JSON.stringify(body) : undefined,
});

test('GET /api/stats/torneo sin config -> 404', async () => {
    await withServer(buildCtx({ withConfig: false }), async (base) => {
        const res = await fetch(`${base}/api/stats/torneo`);
        assert.strictEqual(res.status, 404);
    });
});

test('GET /api/stats/torneo: tabla, series y stats sin candidatas', async () => {
    const games = [g('aaaaaa01', 'Guardian', 'HARDCORE BALL', 200, 50, 0)];
    await withServer(buildCtx({ games }), async (base) => {
        const res = await fetch(`${base}/api/stats/torneo`);
        assert.strictEqual(res.status, 200);
        const body = await res.json();
        assert.strictEqual(body.torneo.nombre, 'Leyendas Oxidadas 2.0');
        assert.strictEqual(body.series.length, 10);
        assert.deepStrictEqual(body.series.find(s => s.n === 2).marcador, { tomm: 1, shine: 0 });
        assert.strictEqual(body.standings.length, 5);
        assert.ok(body.players.find(p => p.nombre === 'Tomm').pj === 1);
        assert.strictEqual(body.candidatas, undefined);
        assert.strictEqual(body.partidas.length, 1);
        assert.strictEqual(body.partidas[0].lados[0].jugadores.length, 4);
        assert.strictEqual(body.revisar, 0);
    });
});

test('admin torneo: sin clave 401; TORNEO_ADMIN_KEY entra con rol torneo y no abre otros admin', async () => {
    await withServer(buildCtx(), async (base) => {
        assert.strictEqual((await fetch(`${base}/api/admin/torneo`)).status, 401);
        const res = await fetch(`${base}/api/admin/torneo`, json('GET', null, 'test-torneo-key'));
        assert.strictEqual(res.status, 200);
        const body = await res.json();
        assert.strictEqual(body.role, 'torneo');
        assert.ok(Array.isArray(body.result.candidatas));
        const other = await fetch(`${base}/api/admin/games`, json('GET', null, 'test-torneo-key'));
        assert.strictEqual(other.status, 401);
        const asAdmin = await fetch(`${base}/api/admin/torneo`, json('GET', null, 'test-admin-key'));
        assert.strictEqual((await asAdmin.json()).role, 'admin');
    });
});

test('admin torneo: override excluir con ID corto, y deshacer', async () => {
    const games = [g('bbbbbb01', 'Guardian', 'HARDCORE BALL', 200, 50, 0)];
    const ctx = buildCtx({ games });
    await withServer(ctx, async (base) => {
        let res = await fetch(`${base}/api/admin/torneo/overrides`, json('POST', { tipo: 'excluir', gameId: 'bbbbbb' }, 'test-torneo-key'));
        assert.strictEqual(res.status, 200);
        const { override } = await res.json();
        assert.strictEqual(override.gameId, 'bbbbbb01');
        assert.strictEqual(override.por, 'web:torneo');

        let pub = await (await fetch(`${base}/api/stats/torneo`)).json();
        assert.strictEqual(pub.series.find(s => s.n === 2).estado, 'pendiente');

        res = await fetch(`${base}/api/admin/torneo/overrides/${override.id}`, json('DELETE', null, 'test-torneo-key'));
        assert.strictEqual(res.status, 200);
        pub = await (await fetch(`${base}/api/stats/torneo`)).json();
        assert.strictEqual(pub.series.find(s => s.n === 2).estado, 'en_curso');
    });
});

test('admin torneo: override inválido -> 400 con motivo', async () => {
    await withServer(buildCtx(), async (base) => {
        const res = await fetch(`${base}/api/admin/torneo/overrides`, json('POST', { tipo: 'wo', serie: 2, ganador: 'zeus' }, 'test-admin-key'));
        assert.strictEqual(res.status, 400);
        assert.match((await res.json()).error, /tomm o shine/);
    });
});

test('admin torneo: PUT config inválida -> 400; gamertag nuevo se asigna', async () => {
    await withServer(buildCtx(), async (base) => {
        let res = await fetch(`${base}/api/admin/torneo`, json('PUT', { nombre: 'x' }, 'test-admin-key'));
        assert.strictEqual(res.status, 400);
        res = await fetch(`${base}/api/admin/torneo/gamertags`,
            json('POST', { equipo: 'tomm', jugador: 'Legit', gamertag: 'Legit PC' }, 'test-torneo-key'));
        assert.strictEqual(res.status, 200);
        assert.deepStrictEqual((await res.json()).gamertags, ['Legitbox', 'Legit PC']);
    });
});

test('captionLineFor: marcador en curso, cierre de serie y partidas ajenas', async () => {
    const games = [
        g('cccccc01', 'Guardian', 'HARDCORE BALL', 200, 50, 0),
        g('cccccc02', 'Narrows', 'HARDCORE TS', 50, 30, 15),
    ];
    const ctx = buildCtx({ games });
    assert.strictEqual(await torneo.captionLineFor(ctx, 'cccccc01'),
        '🏆 Leyendas Oxidadas 2.0 · Serie 2 · Game 1 · Tomm 1-0 Shine');
    assert.strictEqual(await torneo.captionLineFor(ctx, 'cccccc02', 'discord'),
        '🏆 Leyendas Oxidadas 2.0 · Serie 2 · Game 2 · **Gana Tomm 2-0**');
    assert.strictEqual(await torneo.captionLineFor(ctx, 'otra'), null);
    assert.strictEqual(await torneo.captionLineFor(buildCtx({ withConfig: false }), 'cccccc01'), null);
});

test('POST /api/report 4v4 del torneo: WhatsApp y Discord llevan la línea del torneo', async () => {
    const saved = [];
    const ctx = buildCtx();
    // El pipeline reemplaza timestamps "del futuro" con la hora del server:
    // inicio del torneo y partida en el pasado reciente.
    const cfg = { ...seed, inicio: new Date(Date.now() - 60 * 60_000).toISOString() };
    fs.writeFileSync(path.join(ctx.outputDir, 'torneo.json'), JSON.stringify(cfg));
    Object.assign(ctx.supabase, {
        async gameExists(id) { return saved.some(s => s.game_unique_id === id); },
        async saveGame(gameData, players) {
            saved.push({
                game_unique_id: gameData.gameUniqueId, map_name: gameData.mapName, game_type_name: gameData.gameTypeName,
                timestamp: gameData.timestamp, duration: gameData.duration, format: '4v4', is_voided: false,
                players: players.map(p => ({ gamertag: p.gamertag, team_id: p.teamId, score: p.score, kills: p.kills, deaths: p.deaths, assists: p.assists })),
            });
        },
        async getGamesWithPlayersSince() { return saved; },
    });
    const waCalls = [];
    const dcCalls = [];
    ctx.whatsapp = {
        ...ctx.whatsapp,
        isReady: () => true,
        groupIdFor: f => (f === '4v4' ? '5215500000000-111@g.us' : null),
        async sendImage(_p, caption) { waCalls.push(caption); return true; },
    };
    ctx.discord4v4 = { async sendImage(_p, _g, _pl, extraLine) { dcCalls.push(extraLine); return true; } };
    ctx.renderer = { async generatePNG(_g, _p, pngPath) { fs.writeFileSync(pngPath, Buffer.from([0])); } };

    const players = [
        ...TOMM.map((gamertag, i) => ({ gamertag, teamId: 0, kills: 10, deaths: 5, assists: 2, score: i === 0 ? 200 : 0 })),
        ...SHINE.map((gamertag, i) => ({ gamertag, teamId: 1, kills: 5, deaths: 10, assists: 1, score: i === 0 ? 120 : 0 })),
    ];
    await withServer(ctx, async (base) => {
        const res = await fetch(`${base}/api/report`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-api-key': 'k' },
            body: JSON.stringify({
                gameData: {
                    gameUniqueId: 'torneo-game-1', mapName: null, mapCode: 'asq_guardia', gameTypeName: 'HARDCORE BALL',
                    timestamp: new Date(Date.now() - 60_000).toISOString(), duration: 600, isMatchmaking: false, isTeamsEnabled: true,
                },
                players,
                schemaVersion: 1,
            }),
        });
        assert.strictEqual(res.status, 200);
        assert.strictEqual((await res.json()).format, '4v4');
    });
    assert.strictEqual(waCalls.length, 1);
    assert.match(waCalls[0], /\n🏆 Leyendas Oxidadas 2\.0 · Serie 2 · Game 1 · Tomm 1-0 Shine$/);
    assert.deepStrictEqual(dcCalls, ['🏆 Leyendas Oxidadas 2.0 · Serie 2 · Game 1 · Tomm 1-0 Shine']);
});
