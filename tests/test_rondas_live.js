/**
 * Tests del anuncio automático de rondas (formatLiveRoundUpdate) y del
 * marcador de reset (rondasReset).
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { formatLiveRoundUpdate, currentOrLastSession } = require('../server/utils/sessions');
const { getResetTs, setResetTs, filterGamesAfterReset } = require('../server/utils/rondasReset');

let passed = 0;
function test(name, fn) {
    fn();
    passed++;
    console.log(`  ✅ ${name}`);
}

// Partida sintética 2v2: [A,B] vs [C,D]. winner: 'L' izquierda, 'R' derecha, 'T' empate.
let tsBase = Date.now() - 60 * 60 * 1000; // hace 1 hora, sesión viva
function game(winner, minutesAfter) {
    const ts = new Date(tsBase + minutesAfter * 60 * 1000).toISOString();
    const [sL, sR] = winner === 'L' ? [50, 40] : winner === 'R' ? [40, 50] : [45, 45];
    return {
        timestamp: ts,
        map_name: 'Guardian',
        players: [
            { gamertag: 'Alfa', team_id: 0, score: sL / 2 }, { gamertag: 'Beta', team_id: 0, score: sL / 2 },
            { gamertag: 'Cyto', team_id: 1, score: sR / 2 }, { gamertag: 'Delta', team_id: 1, score: sR / 2 },
        ]
    };
}

const session = games => currentOrLastSession(games);

console.log('\n— formatLiveRoundUpdate —');

test('primera partida de la ronda: alguien arriba 1-0', () => {
    const msg = formatLiveRoundUpdate(session([game('L', 0)]));
    assert.ok(msg.includes('Ronda 1'), msg);
    assert.ok(msg.includes('arriba *1-0*'), msg);
    assert.ok(msg.includes('a una de llevarse la ronda'), msg);
});

test('1-1: la que sigue decide', () => {
    const msg = formatLiveRoundUpdate(session([game('L', 0), game('R', 10)]));
    assert.ok(msg.includes('van *1-1*'), msg);
    assert.ok(msg.includes('decide la ronda'), msg);
});

test('2-0 cierra la ronda y anuncia cuenta', () => {
    const msg = formatLiveRoundUpdate(session([game('L', 0), game('L', 10)]));
    assert.ok(msg.includes('🏁'), msg);
    assert.ok(msg.includes('Ronda 1'), msg);
    assert.ok(msg.includes('Alfa + Beta'), msg);
    assert.ok(msg.includes('deben $25'), msg);
});

test('rondas 1-1 entre equipos: cuenta a mano', () => {
    const msg = formatLiveRoundUpdate(session([
        game('L', 0), game('L', 10),           // ronda 1 para L
        game('R', 20), game('R', 30),          // ronda 2 para R
    ]));
    assert.ok(msg.includes('🏁'), msg);
    assert.ok(msg.includes('a mano ($0)'), msg);
});

test('empate: no suma y lo dice', () => {
    const msg = formatLiveRoundUpdate(session([game('L', 0), game('T', 10)]));
    assert.ok(msg.includes('🤝 Empate'), msg);
    assert.ok(msg.includes('arriba *1-0*'), msg);
});

test('tras cerrar ronda, la siguiente partida abre la ronda 2', () => {
    const msg = formatLiveRoundUpdate(session([
        game('L', 0), game('L', 10),           // ronda 1 para L
        game('R', 20),                          // arranca ronda 2
    ]));
    assert.ok(msg.includes('Ronda 2'), msg);
    assert.ok(msg.includes('arriba *1-0*'), msg);
});

test('sesión vacía -> null', () => {
    assert.strictEqual(formatLiveRoundUpdate(null), null);
});

console.log('\n— rondasReset —');

test('sin archivo -> sin reset, no filtra nada', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rondas-reset-'));
    assert.strictEqual(getResetTs(dir), null);
    const games = [game('L', 0), game('R', 10)];
    assert.strictEqual(filterGamesAfterReset(games, dir).length, 2);
});

test('reset filtra las partidas anteriores y respeta las nuevas', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rondas-reset-'));
    const antes = game('L', 0);
    setResetTs(dir, tsBase + 5 * 60 * 1000); // corte entre la partida 0 y la 10
    const despues = game('R', 10);
    const left = filterGamesAfterReset([antes, despues], dir);
    assert.strictEqual(left.length, 1);
    assert.strictEqual(left[0].timestamp, despues.timestamp);
});

test('archivo corrupto -> se ignora sin tronar', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rondas-reset-'));
    fs.writeFileSync(path.join(dir, 'rondas_reset.json'), 'no-es-json{');
    assert.strictEqual(getResetTs(dir), null);
});

console.log(`\n✅ ${passed} tests OK\n`);
