/**
 * Tests del comando !torneo (commands/torneo.js): lecturas públicas y
 * correcciones de organizadores (admins de la config vía roster).
 */

const { test } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createTorneoHandler } = require('../commands/torneo');
const { createGamesCache } = require('../domain/gamesCache');
const { makeLock } = require('../state/locks');
const { logger } = require('../logger');
const roster = require('../utils/roster');
const seed = require('../torneos/leyendas-oxidadas-2.json');

const TOMM = ['SSTomm', 'M4ST3RWARS', 'Legitbox', 'PrimalNewt9929'];
const SHINE = ['iShinedownN', 'Shady Legacyy', 'SsMecoboy', 'hydracoin'];
const TOMM_JID = '5215511111111@s.whatsapp.net';
const RANDOM_JID = '5215522222222@s.whatsapp.net';

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

function buildCtx(games) {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'torneo-cmd-'));
    fs.writeFileSync(path.join(outputDir, 'torneo.json'), JSON.stringify(seed));
    const r = { version: 2, links: [] };
    roster.linkJid(r, TOMM_JID, 'SSTomm');
    roster.saveRoster(outputDir, r);
    const supabase = { async getGamesWithPlayersSince() { return games; }, async getGameWithPlayers() { return null; } };
    return {
        config: { WHATSAPP_ADMIN_JIDS: '' },
        logger,
        supabase,
        whatsapp: { async resolveLidPn(j) { return j.map(() => ({})); } },
        outputDir,
        gamesCache: createGamesCache({ supabase, ttlMs: 60_000 }),
        locks: { withTorneoLock: makeLock() },
    };
}

const run = (ctx, args, senderId = RANDOM_JID) =>
    createTorneoHandler(ctx)({ format: '4v4', args, msg: {}, mentionedIds: [], senderId });

test('!torneo: tabla, líderes y series por jugar', async () => {
    const ctx = buildCtx([g('dddddd01', 'Guardian', 'HARDCORE BALL', 200, 50, 0)]);
    const reply = await run(ctx, '');
    assert.match(reply, /Leyendas Oxidadas 2\.0/);
    assert.match(reply, /1\. \*Tomm\* · 0 0 0 0 · 1-0 \(\+1\) · \*0 pts\*/);
    assert.match(reply, /Serie 2: Tomm vs Shine \(va 1-0\)/);
    assert.ok(!reply.startsWith('!torneo'));
});

test('!torneo serie 2 y stats', async () => {
    const ctx = buildCtx([g('dddddd01', 'Guardian', 'HARDCORE BALL', 200, 50, 0)]);
    const serie = await run(ctx, 'serie 2');
    assert.match(serie, /G1 Guardian Oddball: gana Tomm 200-50/);
    assert.match(serie, /G2 Narrows Slayer: pendiente/);
    assert.match(await run(ctx, 'stats'), /KDA/);
});

test('correcciones: un cualquiera no puede; Tomm (admin de la config) sí', async () => {
    const ctx = buildCtx([g('eeeeee01', 'Guardian', 'HARDCORE BALL', 200, 50, 0)]);
    assert.match(await run(ctx, 'excluir eeeeee01'), /Solo los organizadores/);

    const reply = await run(ctx, 'excluir eeeeee01', TOMM_JID);
    assert.match(reply, /Listo \(excluir\)/);
    assert.match(reply, /pendiente/);
    const saved = JSON.parse(fs.readFileSync(path.join(ctx.outputDir, 'torneo.json'), 'utf8'));
    assert.strictEqual(saved.overrides[0].por, 'SSTomm');

    const undo = await run(ctx, 'deshacer', TOMM_JID);
    assert.match(undo, /Deshecho: excluir eeeeee01/);
    assert.match(undo, /gana Tomm/);
});

test('resultado manual y W.O. por nombre de equipo; errores legibles', async () => {
    const ctx = buildCtx([]);
    let reply = await run(ctx, 'resultado 2 1 tomm', TOMM_JID);
    assert.match(reply, /G1 Guardian Oddball: gana Tomm \(resultado manual, SSTomm\)/);
    reply = await run(ctx, 'wo 5 zeus', TOMM_JID);
    assert.match(reply, /W\.O\. a favor de Zeus/);
    reply = await run(ctx, 'wo 5 buda', TOMM_JID);
    assert.match(reply, /No se pudo: El ganador debe ser zeus o shine/);
    reply = await run(ctx, 'fijar abc 2 1', TOMM_JID);
    assert.match(reply, /al menos 6 caracteres/);
});

test('!torneo revisar lista partidas fuera de calendario y gamertags nuevos', async () => {
    const wrong = g('ffffff01', 'Heretic', 'HARDCORE CTF', 3, 1, 0);
    wrong.players[3].gamertag = 'Legit Alterno';
    const ctx = buildCtx([wrong]);
    const reply = await run(ctx, 'revisar', TOMM_JID);
    assert.match(reply, /ffffff01 · Heretic HARDCORE CTF · Tomm vs Shine · revisar/);
    assert.match(reply, /Legit Alterno jugando con Tomm/);
});

test('!torneo empate <serie>: 1 punto para cada uno', async () => {
    const ctx = buildCtx([]);
    const reply = await run(ctx, 'empate 2', TOMM_JID);
    assert.match(reply, /Serie 2: Tomm vs Shine\* — empate/);
    assert.match(reply, /Empate declarado \(por SSTomm\)/);
    const tabla = await run(ctx, '');
    assert.match(tabla, /\*Tomm\* · 1 0 1 0 · 0-0 \(\+0\) · \*1 pts\*/);
});
