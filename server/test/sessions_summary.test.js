/**
 * Tests de summarizeSession (Fase C2): el resumen estructurado que consume
 * la vista web de !rondas, verificando que sea consistente con
 * formatRondasMessage (misma fuente de verdad, ver utils/sessions.js).
 */

const { test } = require('node:test');
const assert = require('assert');

const { currentOrLastSession, summarizeSession, formatRondasMessage } = require('../utils/sessions');

// Partida sintética 2v2: [Alfa,Beta] vs [Cyto,Delta]. winner: 'L' izquierda
// (Alfa+Beta), 'R' derecha (Cyto+Delta), 'T' empate.
let tsBase = Date.now() - 60 * 60 * 1000; // hace 1 hora, sesión viva
function game(winner, minutesAfter, overrides = {}) {
    const ts = new Date(tsBase + minutesAfter * 60 * 1000).toISOString();
    const [sL, sR] = winner === 'L' ? [50, 40] : winner === 'R' ? [40, 50] : [45, 45];
    return {
        game_unique_id: `g_${minutesAfter}`,
        timestamp: ts,
        map_name: 'Guardian',
        players: [
            { gamertag: 'Alfa', team_id: 0, score: sL / 2 }, { gamertag: 'Beta', team_id: 0, score: sL / 2 },
            { gamertag: 'Cyto', team_id: 1, score: sR / 2 }, { gamertag: 'Delta', team_id: 1, score: sR / 2 },
        ],
        ...overrides,
    };
}

const session = games => currentOrLastSession(games);

console.log('\n— summarizeSession —');

test('sesión vacía o nula -> null', () => {
    assert.strictEqual(summarizeSession(null), null);
    assert.strictEqual(summarizeSession({ games: [], live: true }), null);
});

test('sin ganador claro: campos base de la sesión', () => {
    const s = summarizeSession(session([game('L', 0)]));
    assert.strictEqual(s.live, true);
    assert.strictEqual(s.gamesCount, 1);
    assert.strictEqual(typeof s.dateLabel, 'string');
    assert.ok(s.startedAt);
    assert.ok(s.lastGameAt);
    assert.strictEqual(s.enfrentamientos.length, 1);
});

test('ronda cerrada 2-0: rondas, ganador y cuenta cuadran con el texto de WhatsApp', () => {
    const games = [game('L', 0), game('L', 10)];
    const sess = session(games);
    const s = summarizeSession(sess);
    const msg = formatRondasMessage(sess);

    const [e] = s.enfrentamientos;
    assert.deepStrictEqual(e.sides[0], ['Alfa', 'Beta']); // va arriba -> izquierda
    assert.deepStrictEqual(e.sides[1], ['Cyto', 'Delta']);
    assert.deepStrictEqual(e.rondasWon, [1, 0]);
    assert.strictEqual(e.rondas.length, 1);
    assert.strictEqual(e.rondas[0].winnerSide, 0);
    assert.strictEqual(e.rondas[0].games.length, 2);
    assert.strictEqual(e.rondas[0].games[0].kind, 'game');
    assert.strictEqual(e.rondas[0].games[0].map, 'Guardian');
    assert.deepStrictEqual(e.rondas[0].games[0].scores, [50, 40]);
    assert.strictEqual(e.current, null);

    assert.strictEqual(s.cuenta.length, 1);
    assert.deepStrictEqual(s.cuenta[0].winners, ['Alfa', 'Beta']);
    assert.deepStrictEqual(s.cuenta[0].losers, ['Cyto', 'Delta']);
    assert.strictEqual(s.cuenta[0].rounds, 1);
    assert.strictEqual(s.cuenta[0].amountMxn, 25);

    // Coherencia con el texto de WhatsApp (misma fuente de verdad)
    assert.ok(msg.includes('Alfa + Beta'));
    assert.ok(msg.includes('deben *$25*'));
});

test('ronda en curso (no cerrada): current refleja el marcador parcial', () => {
    const games = [game('L', 0)];
    const s = summarizeSession(session(games));
    const [e] = s.enfrentamientos;
    assert.strictEqual(e.current.wins[0], 1);
    assert.strictEqual(e.current.wins[1], 0);
    assert.strictEqual(e.current.games.length, 1);
    assert.strictEqual(e.rondas.length, 0);
    assert.strictEqual(s.cuenta.length, 0, 'ronda a medias no cuenta para la cuenta');
});

test('empate: winnerSide null y no suma a ninguna ronda', () => {
    const games = [game('T', 0)];
    const s = summarizeSession(session(games));
    const [e] = s.enfrentamientos;
    assert.strictEqual(e.current.games[0].winnerSide, null);
});

test('W.O. se marca kind=wo y ajuste kind=ajuste', () => {
    const wo = game('L', 0, { game_unique_id: 'wo_1', map_name: 'W.O.', is_forfeit: true });
    const ajuste = game('R', 10, { game_unique_id: 'aj_1', map_name: 'Ajuste', is_adjustment: true });
    const real = game('L', 20);
    const s = summarizeSession(session([wo, ajuste, real]));
    const [e] = s.enfrentamientos;
    const allGames = [...e.rondas.flatMap(r => r.games), ...(e.current ? e.current.games : [])];
    assert.ok(allGames.some(g => g.kind === 'wo'));
    assert.ok(allGames.some(g => g.kind === 'ajuste'));
    assert.ok(allGames.some(g => g.kind === 'game'));
});

test('sesión terminada (no live) con ronda a medias: no cuenta pero sigue en current', () => {
    const games = [game('L', 0)];
    const s = summarizeSession({ games, live: false });
    assert.strictEqual(s.live, false);
    assert.ok(s.enfrentamientos[0].current);
    const msg = formatRondasMessage({ games, live: false });
    assert.ok(msg.includes('quedó abierta'));
    assert.ok(msg.includes('no cuenta'));
});

test('cuenta rondaMxn configurable vía opts', () => {
    const games = [game('L', 0), game('L', 10)];
    const s = summarizeSession(session(games), { rondaMxn: 100 });
    assert.strictEqual(s.cuenta[0].amountMxn, 100);
});
