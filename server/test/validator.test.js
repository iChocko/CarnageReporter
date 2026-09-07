/**
 * Tests de services/validator.js (evaluateMatch): cubre cada regla de
 * anulación automática, una por una, más el caso válido.
 */

const { test } = require('node:test');
const assert = require('assert');

const { evaluateMatch, VOID_MIN_DURATION_SECONDS } = require('../services/validator');

// Partida 2v2 sintética: [A,B] vs [C,D]. Los scores por defecto no alcanzan
// el puntaje de victoria (25) ni se acercan, para no disparar reachedWinScore.
function players2v2({ scores = [5, 5, 4, 4], completed } = {}) {
    const base = [
        { gamertag: 'A', teamId: 0, score: scores[0] },
        { gamertag: 'B', teamId: 0, score: scores[1] },
        { gamertag: 'C', teamId: 1, score: scores[2] },
        { gamertag: 'D', teamId: 1, score: scores[3] },
    ];
    if (completed) {
        base.forEach((p, i) => { p.completedGame = completed[i]; });
    }
    return base;
}

test('formato no soportado (ni 2v2 ni 4v4) -> unsupported_format, cualquier versión', () => {
    const players = [
        { gamertag: 'A', teamId: 0 },
        { gamertag: 'B', teamId: 1 },
        { gamertag: 'C', teamId: 2 },
    ];
    const r = evaluateMatch({}, players, 2);
    assert.deepStrictEqual(r, { voided: true, reason: 'unsupported_format' });
});

test('lastMatchIncomplete=true -> anulada, formato válido, cualquier versión', () => {
    const r = evaluateMatch({ lastMatchIncomplete: true }, players2v2(), 1);
    assert.deepStrictEqual(r, { voided: true, reason: 'last_match_incomplete' });
});

test('too_short: partida corta que NO alcanzó el puntaje de victoria -> anulada', () => {
    const gameData = { duration: VOID_MIN_DURATION_SECONDS - 10 };
    const r = evaluateMatch(gameData, players2v2({ scores: [5, 5, 4, 4] }), 2);
    assert.deepStrictEqual(r, { voided: true, reason: 'too_short' });
});

test('too_short: partida corta pero un equipo SÍ llegó a 25 -> no se anula por corta', () => {
    const gameData = { duration: VOID_MIN_DURATION_SECONDS - 10 };
    const r = evaluateMatch(gameData, players2v2({ scores: [15, 15, 4, 4] }), 2);
    assert.deepStrictEqual(r, { voided: false, reason: null });
});

test('majority_quit: la mayoría marcó completedGame=0 -> anulada', () => {
    const gameData = { duration: VOID_MIN_DURATION_SECONDS + 50 };
    const players = players2v2({ completed: [0, 0, 0, 1] });
    const r = evaluateMatch(gameData, players, 2);
    assert.deepStrictEqual(r, { voided: true, reason: 'majority_quit' });
});

test('completedGame en minoría no anula (menos de la mitad se fue)', () => {
    const gameData = { duration: VOID_MIN_DURATION_SECONDS + 50 };
    const players = players2v2({ completed: [0, 1, 1, 1] });
    const r = evaluateMatch(gameData, players, 2);
    assert.deepStrictEqual(r, { voided: false, reason: null });
});

test('payload v1 (schemaVersion 1): las reglas de duración/completitud se saltan', () => {
    // Duración 0 (típico de clientes v1) y ninguna marca de completitud:
    // si las reglas de v2 se evaluaran igual, esto no dispararía nada; el
    // punto de esta prueba es que ni siquiera se intenta leer esos campos.
    const gameData = { duration: 0 };
    const r = evaluateMatch(gameData, players2v2({ completed: [0, 0, 0, 0] }), 1);
    assert.deepStrictEqual(r, { voided: false, reason: null });
});

test('partida válida (2v2, duración normal, todos completaron) -> no anulada', () => {
    const gameData = { duration: VOID_MIN_DURATION_SECONDS + 100 };
    const players = players2v2({ scores: [15, 14, 10, 9], completed: [1, 1, 1, 1] });
    const r = evaluateMatch(gameData, players, 2);
    assert.deepStrictEqual(r, { voided: false, reason: null });
});
