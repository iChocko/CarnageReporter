/**
 * Tests de la lógica pura del torneo (utils/torneo.js) con la config real
 * de Leyendas Oxidadas 2.0 (server/torneos/leyendas-oxidadas-2.json).
 */

const { test } = require('node:test');
const assert = require('assert');

const seed = require('../torneos/leyendas-oxidadas-2.json');
const {
    modeOf, mapMatches, isUnknownMap, normalizeConfig, resolveSides, computeTorneo, contextForGame,
} = require('../utils/torneo');

const ROSTERS = {
    tomm: ['SSTomm', 'M4ST3RWARS', 'Legitbox', 'PrimalNewt9929'],
    zeus: ['Zeuz Zee', 'iChocko', 'Prymne', 'Always iDreaMz'],
    shine: ['iShinedownN', 'Shady Legacyy', 'SsMecoboy', 'hydracoin'],
    jahyr: ['iOut x JaHyyR', 'a Hannibal', 'OMG ItZ WilliaM', 'Jk sssss'],
    buda: ['lBuda', 'eL T AA O', 'II BR Deco II', 'BLACK ANGEL9607'],
};

const T0 = Date.parse('2026-10-27T21:00:00-06:00');
let seq = 0;

/**
 * Partida falsa: el lado A (team_id 0) suma `scoreA` repartido en su primer
 * jugador; el lado B (team_id 1) suma `scoreB`.
 */
function game({ a, b, map, type, scoreA, scoreB, min = 0, id, voided = false, voidReason = null, swap = false, playersA, playersB, dc = [] }) {
    const ta = swap ? 1 : 0, tb = swap ? 0 : 1;
    const mk = (tags, team, score) => tags.map((gamertag, i) => ({
        gamertag, team_id: team, score: i === 0 ? score : 0,
        kills: 10 + i, deaths: 8, assists: 3, most_kills_in_a_row: 4,
        completed_game: dc.includes(gamertag) ? 0 : 1,
    }));
    return {
        game_unique_id: id || `g${++seq}`,
        map_name: map,
        game_type_name: type,
        timestamp: new Date(T0 + min * 60_000).toISOString(),
        duration: 600,
        format: '4v4',
        is_voided: voided,
        void_reason: voidReason,
        players: [...mk(playersA || ROSTERS[a], ta, scoreA), ...mk(playersB || ROSTERS[b], tb, scoreB)],
    };
}

const cfgWith = (overrides = []) => normalizeConfig({ ...seed, overrides });
const serie = (res, n) => res.series.find(s => s.n === n);
const cand = (res, id) => res.candidatas.find(c => c.gameId === id);

test('modeOf: traduce los game types de la comunidad', () => {
    assert.strictEqual(modeOf('HARDCORE CTF'), 'ctf');
    assert.strictEqual(modeOf('HARDCORE TS'), 'slayer');
    assert.strictEqual(modeOf('HARDCORE CON TS'), 'slayer');
    assert.strictEqual(modeOf('TEAM SLAYER BR'), 'slayer');
    assert.strictEqual(modeOf('HARDCORE BALL'), 'oddball');
    assert.strictEqual(modeOf('HARDCORE KING'), 'koth');
    assert.strictEqual(modeOf('ALGO RARO'), null);
});

test('mapas: Onslaught acepta Foundry; mapa desconocido se detecta', () => {
    assert.ok(mapMatches('Foundry', 'Onslaught'));
    assert.ok(mapMatches('onslaught', 'Onslaught'));
    assert.ok(mapMatches('The Pit', 'The Pit'));
    assert.ok(!mapMatches('Narrows', 'Onslaught'));
    assert.ok(isUnknownMap('Mapa por confirmar'));
    assert.ok(isUnknownMap('Mapa desconocido'));
    assert.ok(!isUnknownMap('Guardian'));
});

test('normalizeConfig: la config real es válida; gamertag duplicado truena', () => {
    const cfg = normalizeConfig(seed);
    assert.strictEqual(cfg.series.length, 10);
    assert.strictEqual(cfg.equipos.length, 5);
    const bad = JSON.parse(JSON.stringify(seed));
    bad.equipos[1].jugadores[0].gamertags.push('SSTomm');
    assert.throws(() => normalizeConfig(bad), /SSTomm/);
});

test('resolveSides: 4/4 y 3/4 con suplente cuentan; 2/4 no', () => {
    const cfg = cfgWith();
    const full = resolveSides(game({ a: 'tomm', b: 'shine', map: 'Guardian', type: 'HARDCORE BALL', scoreA: 1, scoreB: 0 }), cfg);
    assert.deepStrictEqual(full.sides.map(s => s.teamId).sort(), ['shine', 'tomm']);

    const sub = resolveSides(game({ a: 'tomm', b: 'shine', map: 'Guardian', type: 'HARDCORE BALL', scoreA: 1, scoreB: 0,
        playersA: ['SSTomm', 'M4ST3RWARS', 'PrimalNewt9929', 'Invitado X'] }), cfg);
    const tommSide = sub.sides.find(s => s.teamId === 'tomm');
    assert.ok(tommSide.members.find(m => m.player.gamertag === 'Invitado X').suplente);

    const two = resolveSides(game({ a: 'tomm', b: 'shine', map: 'Guardian', type: 'HARDCORE BALL', scoreA: 1, scoreB: 0,
        playersA: ['SSTomm', 'M4ST3RWARS', 'Otro 1', 'Otro 2'] }), cfg);
    assert.strictEqual(two, null);
});

test('serie 2 completa 2-1, con lados invertidos de color', () => {
    const g1 = game({ a: 'tomm', b: 'shine', map: 'Guardian', type: 'HARDCORE BALL', scoreA: 200, scoreB: 150, min: 0 });
    const g2 = game({ a: 'tomm', b: 'shine', map: 'Narrows', type: 'HARDCORE TS', scoreA: 40, scoreB: 50, min: 15, swap: true });
    const g3 = game({ a: 'tomm', b: 'shine', map: 'Foundry', type: 'HARDCORE CTF', scoreA: 3, scoreB: 1, min: 30 });
    const res = computeTorneo(cfgWith(), [g3, g1, g2]);
    const s2 = serie(res, 2);
    assert.strictEqual(s2.estado, 'terminada');
    assert.strictEqual(s2.ganador, 'tomm');
    assert.deepStrictEqual(s2.marcador, { tomm: 2, shine: 1 });
    assert.deepStrictEqual(s2.games.map(g => g.ganador), ['tomm', 'shine', 'tomm']);

    const top = res.standings[0];
    assert.strictEqual(top.id, 'tomm');
    assert.strictEqual(top.seriesGanadas, 1);
    assert.strictEqual(top.partidasGanadas, 2);
});

test('fuera de orden: el slot sale del mapa/modo, no del orden', () => {
    const g2 = game({ a: 'tomm', b: 'shine', map: 'Narrows', type: 'HARDCORE TS', scoreA: 50, scoreB: 30, min: 0 });
    const g1 = game({ a: 'tomm', b: 'shine', map: 'Guardian', type: 'HARDCORE BALL', scoreA: 200, scoreB: 10, min: 15 });
    const res = computeTorneo(cfgWith(), [g1, g2]);
    const s2 = serie(res, 2);
    assert.strictEqual(s2.estado, 'terminada');
    assert.strictEqual(s2.games[0].gameId, g1.game_unique_id);
    assert.strictEqual(s2.games[1].gameId, g2.game_unique_id);
});

test('reinicio: dos partidas en el mismo slot, cuenta la última', () => {
    const first = game({ a: 'tomm', b: 'shine', map: 'Guardian', type: 'HARDCORE BALL', scoreA: 60, scoreB: 20, min: 0 });
    const replay = game({ a: 'tomm', b: 'shine', map: 'Guardian', type: 'HARDCORE BALL', scoreA: 100, scoreB: 200, min: 10 });
    const res = computeTorneo(cfgWith(), [first, replay]);
    assert.strictEqual(serie(res, 2).games[0].ganador, 'shine');
    assert.strictEqual(cand(res, first.game_unique_id).estado, 'reiniciada');
    assert.strictEqual(cand(res, replay.game_unique_id).estado, 'cuenta');
    // stats individuales: la reiniciada no suma
    const tomm = res.players.find(p => p.nombre === 'Tomm');
    assert.strictEqual(tomm.pj, 1);
});

test('empate: no suma al marcador, se repite y las stats del empate sí cuentan', () => {
    const draw = game({ a: 'tomm', b: 'shine', map: 'Guardian', type: 'HARDCORE BALL', scoreA: 100, scoreB: 100, min: 0 });
    const replay = game({ a: 'tomm', b: 'shine', map: 'Guardian', type: 'HARDCORE BALL', scoreA: 200, scoreB: 100, min: 12 });
    const res = computeTorneo(cfgWith(), [draw, replay]);
    assert.strictEqual(cand(res, draw.game_unique_id).estado, 'empate');
    assert.deepStrictEqual(serie(res, 2).marcador, { tomm: 1, shine: 0 });
    const tomm = res.players.find(p => p.nombre === 'Tomm');
    assert.strictEqual(tomm.pj, 2);
    assert.strictEqual(tomm.empates, 1);
});

test('G3 después de 2-0 y partidas en mapa equivocado -> revisar', () => {
    const g1 = game({ a: 'tomm', b: 'shine', map: 'Guardian', type: 'HARDCORE BALL', scoreA: 200, scoreB: 10, min: 0 });
    const g2 = game({ a: 'tomm', b: 'shine', map: 'Narrows', type: 'HARDCORE TS', scoreA: 50, scoreB: 30, min: 15 });
    const g3 = game({ a: 'tomm', b: 'shine', map: 'Foundry', type: 'HARDCORE CTF', scoreA: 0, scoreB: 3, min: 30 });
    const wrong = game({ a: 'tomm', b: 'shine', map: 'Heretic', type: 'HARDCORE CTF', scoreA: 1, scoreB: 3, min: 45 });
    const res = computeTorneo(cfgWith(), [g1, g2, g3, wrong]);
    assert.deepStrictEqual(serie(res, 2).marcador, { tomm: 2, shine: 0 });
    assert.strictEqual(cand(res, g3.game_unique_id).estado, 'revisar');
    assert.strictEqual(cand(res, wrong.game_unique_id).estado, 'revisar');
    assert.match(cand(res, wrong.game_unique_id).motivo, /no está en la serie 2/);
});

test('mapa por confirmar: decide el modo; CTF ambiguo va al primer slot libre', () => {
    // Serie 5: G1 Onslaught CTF, G2 Construct slayer, G3 Heretic CTF
    const a = game({ a: 'zeus', b: 'shine', map: 'Mapa por confirmar', type: 'HARDCORE CTF', scoreA: 3, scoreB: 0, min: 0 });
    const b = game({ a: 'zeus', b: 'shine', map: 'Construct', type: 'HARDCORE CON TS', scoreA: 30, scoreB: 50, min: 15 });
    const c = game({ a: 'zeus', b: 'shine', map: 'Mapa por confirmar', type: 'HARDCORE CTF', scoreA: 3, scoreB: 1, min: 30 });
    const res = computeTorneo(cfgWith(), [a, b, c]);
    const s5 = serie(res, 5);
    assert.strictEqual(s5.games[0].gameId, a.game_unique_id);
    assert.strictEqual(s5.games[2].gameId, c.game_unique_id);
    assert.strictEqual(s5.ganador, 'zeus');
});

test('serie suspendida se reanuda días después', () => {
    const g1 = game({ a: 'jahyr', b: 'buda', map: 'Narrows', type: 'HARDCORE CTF', scoreA: 3, scoreB: 1, min: 0 });
    let res = computeTorneo(cfgWith(), [g1]);
    assert.strictEqual(serie(res, 10).estado, 'en_curso');
    const g2 = game({ a: 'jahyr', b: 'buda', map: 'Construct', type: 'HARDCORE CON TS', scoreA: 50, scoreB: 40, min: 3 * 24 * 60 });
    res = computeTorneo(cfgWith(), [g1, g2]);
    assert.strictEqual(serie(res, 10).estado, 'terminada');
    assert.strictEqual(serie(res, 10).ganador, 'jahyr');
});

test('partida anulada por el validador: candidata, y cuenta al fijarla', () => {
    const v = game({ a: 'tomm', b: 'zeus', map: 'The Pit', type: 'HARDCORE CTF', scoreA: 3, scoreB: 2, min: 0,
        voided: true, voidReason: 'unsupported_format', id: 'voided1' });
    let res = computeTorneo(cfgWith(), [v]);
    assert.strictEqual(cand(res, 'voided1').estado, 'anulada');
    assert.strictEqual(serie(res, 1).estado, 'pendiente');

    res = computeTorneo(cfgWith([{ id: 'o1', tipo: 'fijar', gameId: 'voided1', serie: 1, slot: 1 }]), [v]);
    assert.strictEqual(cand(res, 'voided1').estado, 'cuenta');
    assert.deepStrictEqual(serie(res, 1).marcador, { tomm: 1, zeus: 0 });
});

test('fijar una partida de mapa equivocado al slot que validaron los organizadores', () => {
    const wrong = game({ a: 'tomm', b: 'zeus', map: 'Amplified', type: 'HARDCORE CTF', scoreA: 0, scoreB: 3, min: 0, id: 'wrongmap' });
    const res = computeTorneo(cfgWith([{ id: 'o1', tipo: 'fijar', gameId: 'wrongmap', serie: 1, slot: 1 }]), [wrong]);
    assert.strictEqual(serie(res, 1).games[0].ganador, 'zeus');
});

test('excluir: la partida deja de contar', () => {
    const g = game({ a: 'tomm', b: 'shine', map: 'Guardian', type: 'HARDCORE BALL', scoreA: 200, scoreB: 10, id: 'ex1' });
    const res = computeTorneo(cfgWith([{ id: 'o1', tipo: 'excluir', gameId: 'ex1' }]), [g]);
    assert.strictEqual(cand(res, 'ex1').estado, 'excluida');
    assert.strictEqual(serie(res, 2).estado, 'pendiente');
});

test('resultado manual de un slot: cuenta para la tabla, no para stats', () => {
    const g2 = game({ a: 'tomm', b: 'shine', map: 'Narrows', type: 'HARDCORE TS', scoreA: 50, scoreB: 30, min: 15 });
    const res = computeTorneo(cfgWith([
        { id: 'o1', tipo: 'resultado', serie: 2, slot: 1, ganador: 'tomm', nota: 'foto a TAAO', at: new Date(T0).toISOString() },
    ]), [g2]);
    const s2 = serie(res, 2);
    assert.strictEqual(s2.estado, 'terminada');
    assert.strictEqual(s2.games[0].manual.ganador, 'tomm');
    assert.strictEqual(res.players.find(p => p.nombre === 'Tomm').pj, 1);
});

test('W.O. conserva lo jugado y completa la serie; cancelar no cuenta para nadie', () => {
    const g1 = game({ a: 'shine', b: 'buda', map: 'Heretic', type: 'HARDCORE CTF', scoreA: 0, scoreB: 3, min: 0 });
    let res = computeTorneo(cfgWith([{ id: 'o1', tipo: 'wo', serie: 9, ganador: 'shine' }]), [g1]);
    let s9 = serie(res, 9);
    assert.strictEqual(s9.estado, 'wo');
    assert.deepStrictEqual(s9.marcador, { shine: 2, buda: 1 });
    assert.strictEqual(res.standings.find(r => r.id === 'shine').seriesGanadas, 1);

    res = computeTorneo(cfgWith([{ id: 'o2', tipo: 'cancelar', serie: 9 }]), [g1]);
    s9 = serie(res, 9);
    assert.strictEqual(s9.estado, 'cancelada');
    assert.strictEqual(res.standings.find(r => r.id === 'buda').partidasGanadas, 0);
    assert.strictEqual(res.players.find(p => p.nombre === 'Buda').pj, 0);
});

test('desconexión: se marca DC y la partida cuenta; gamertag no registrado aparece', () => {
    const g = game({ a: 'tomm', b: 'shine', map: 'Guardian', type: 'HARDCORE BALL', scoreA: 200, scoreB: 100,
        playersB: ['iShinedownN', 'Shady Legacyy', 'SsMecoboy', 'Cuenta Alterna'], dc: ['SsMecoboy'] });
    const res = computeTorneo(cfgWith(), [g]);
    const c = cand(res, g.game_unique_id);
    assert.strictEqual(c.estado, 'cuenta');
    assert.deepStrictEqual(c.noRegistrados, [{ gamertag: 'Cuenta Alterna', equipo: 'shine' }]);
    assert.strictEqual(res.players.find(p => p.nombre === 'Mecoboy').dcs, 1);
    const alt = res.players.find(p => p.nombre === 'Cuenta Alterna');
    assert.ok(alt && !alt.registrado && alt.equipo === 'shine');
});

test('varios gamertags de la misma persona se suman', () => {
    const a = game({ a: 'tomm', b: 'buda', map: 'Construct', type: 'HARDCORE KING', scoreA: 100, scoreB: 200, min: 0 });
    const b = game({ a: 'tomm', b: 'buda', map: 'Amplified', type: 'HARDCORE TS', scoreA: 30, scoreB: 50, min: 15,
        playersB: ['Buda AJ', 'eL T AA O', 'II BR Deco II', 'BLACK ANGEL9607'] });
    const res = computeTorneo(cfgWith(), [a, b]);
    const buda = res.players.find(p => p.nombre === 'Buda');
    assert.strictEqual(buda.pj, 2);
    assert.deepStrictEqual(buda.gamertags.sort(), ['Buda AJ', 'lBuda']);
});

test('scrims antes del inicio no cuentan', () => {
    const early = game({ a: 'tomm', b: 'shine', map: 'Guardian', type: 'HARDCORE BALL', scoreA: 200, scoreB: 10, min: -24 * 60 });
    const res = computeTorneo(cfgWith(), [early]);
    assert.strictEqual(res.candidatas.length, 0);
    assert.strictEqual(serie(res, 2).estado, 'pendiente');
});

test('tabla: desempate head-to-head entre dos equipos', () => {
    // Tomm le gana a Shine; Shine le gana a Zeus; Zeus le gana a Tomm -> 1 serie cada uno (triple empate)
    // y Jahyr le gana a Buda. Para un empate de 2: Tomm y Jahyr con 1 serie; Tomm-Jahyr serie 3 la gana Jahyr.
    const w = (a, b, map, type, min) => game({ a, b, map, type, scoreA: 3, scoreB: 0, min });
    const games = [
        w('tomm', 'shine', 'Guardian', 'HARDCORE BALL', 0), w('tomm', 'shine', 'Narrows', 'HARDCORE TS', 10),
        w('jahyr', 'tomm', 'Heretic', 'HARDCORE CTF', 20), w('jahyr', 'tomm', 'The Pit', 'HARDCORE TS', 30),
    ];
    const res = computeTorneo(cfgWith(), games);
    const order = res.standings.map(r => r.id);
    assert.ok(order.indexOf('jahyr') < order.indexOf('tomm'));
});

test('contextForGame: serie, slot y marcador para el caption', () => {
    const g1 = game({ a: 'tomm', b: 'shine', map: 'Guardian', type: 'HARDCORE BALL', scoreA: 200, scoreB: 10, id: 'ctx1' });
    const res = computeTorneo(cfgWith(), [g1]);
    const ctx = contextForGame(res, 'ctx1');
    assert.strictEqual(ctx.serie, 2);
    assert.strictEqual(ctx.slot, 1);
    assert.deepStrictEqual(ctx.marcador, { tomm: 1, shine: 0 });
    assert.strictEqual(contextForGame(res, 'nope'), null);

    // Con la serie ya terminada, el G1 sigue diciendo 1-0 (marcador a esa hora)
    const g2 = game({ a: 'tomm', b: 'shine', map: 'Narrows', type: 'HARDCORE TS', scoreA: 50, scoreB: 10, min: 15, id: 'ctx2' });
    const res2 = computeTorneo(cfgWith(), [g1, g2]);
    assert.deepStrictEqual(contextForGame(res2, 'ctx1').marcador, { tomm: 1, shine: 0 });
    assert.strictEqual(contextForGame(res2, 'ctx2').ganadorSerie, 'tomm');
});
