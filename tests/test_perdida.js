/**
 * Tests del walkover (!perdida): persistencia de forfeits.js, la partida
 * virtual W.O. y su integración con la tubería de rondas (sessions.js).
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const forfeits = require('../server/utils/forfeits');
const { teamOutcomes } = require('../server/utils/records');
const { currentOrLastSession, formatLiveRoundUpdate, formatRondasMessage } = require('../server/utils/sessions');
const { filterGamesAfterReset, setResetTs } = require('../server/utils/rondasReset');

let passed = 0;
function test(name, fn) {
    fn();
    passed++;
    console.log(`  ✅ ${name}`);
}

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wa-forfeits-'));

// Partida real sintética 2v2: [Alfa,Beta] vs [Cyto,Delta]
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

function forfeit(loserSide, minutesAfter) {
    return {
        timestamp: new Date(tsBase + minutesAfter * 60 * 1000).toISOString(),
        sides: [['Alfa', 'Beta'], ['Cyto', 'Delta']],
        loserSide,
        declaredBy: 'test@c.us',
    };
}

const merge = (games, fs_) => [...games, ...fs_.map(forfeits.forfeitToGame)]
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

console.log('\n— forfeits.js (persistencia) —');

test('archivo faltante o corrupto -> lista vacía sin tronar', () => {
    const dir = tmpDir();
    assert.deepStrictEqual(forfeits.loadForfeits(dir).forfeits, []);
    fs.writeFileSync(path.join(dir, forfeits.FORFEITS_FILE), 'no-es-json{');
    assert.deepStrictEqual(forfeits.loadForfeits(dir).forfeits, []);
});

test('round-trip: save, load, y entradas inválidas se descartan', () => {
    const dir = tmpDir();
    const data = { version: 1, forfeits: [forfeit(1, 10), { basura: true }, forfeit(0, 20)] };
    forfeits.saveForfeits(dir, data);
    const loaded = forfeits.loadForfeits(dir);
    assert.strictEqual(loaded.forfeits.length, 2); // la basura se filtró
    assert.strictEqual(loaded.forfeits[0].loserSide, 1);
});

test('timestamp que no parsea se descarta (no envenena las sesiones con NaN)', () => {
    const dir = tmpDir();
    const malo = { ...forfeit(1, 10), timestamp: 'manana' };
    forfeits.saveForfeits(dir, { version: 1, forfeits: [malo, forfeit(0, 20)] });
    const loaded = forfeits.loadForfeits(dir);
    assert.strictEqual(loaded.forfeits.length, 1);
    assert.strictEqual(loaded.forfeits[0].loserSide, 0);
});

test('lineupKeyOf: misma llave sin importar orden de lados o nombres', () => {
    const a = forfeits.lineupKeyOf([['Alfa', 'Beta'], ['Cyto', 'Delta']]);
    const b = forfeits.lineupKeyOf([['delta', 'CYTO'], ['beta', 'alfa']]);
    assert.strictEqual(a, b);
    const c = forfeits.lineupKeyOf([['Alfa', 'Otro'], ['Cyto', 'Delta']]);
    assert.notStrictEqual(a, c);
});

console.log('\n— forfeitToGame (partida virtual) —');

test('el equipo contrario al que la da por perdida GANA', () => {
    const g = forfeits.forfeitToGame(forfeit(1, 10)); // pierde Cyto+Delta
    const outcomes = teamOutcomes(g);
    assert.strictEqual(outcomes.get('Alfa'), 'W');
    assert.strictEqual(outcomes.get('Beta'), 'W');
    assert.strictEqual(outcomes.get('Cyto'), 'L');
    assert.strictEqual(outcomes.get('Delta'), 'L');
});

test('la partida virtual trae mapa W.O. y marca is_forfeit', () => {
    const g = forfeits.forfeitToGame(forfeit(0, 10));
    assert.strictEqual(g.map_name, 'W.O.');
    assert.strictEqual(g.is_forfeit, true);
    assert.strictEqual(g.players.length, 4);
});

console.log('\n— sideIndexOf —');

test('encuentra el lado del gamertag (case-insensitive) o -1', () => {
    const sides = [['Alfa', 'Beta'], ['Cyto', 'Delta']];
    assert.strictEqual(forfeits.sideIndexOf(sides, 'alfa'), 0);
    assert.strictEqual(forfeits.sideIndexOf(sides, 'DELTA'), 1);
    assert.strictEqual(forfeits.sideIndexOf(sides, 'Nadie'), -1);
});

console.log('\n— integración con rondas —');

test('W.O. cierra la ronda 2-0 y cobra los $25', () => {
    // Alfa+Beta ganan la 1a real; Cyto+Delta dan por perdida la 2a
    const games = merge([game('L', 0)], [forfeit(1, 10)]);
    const msg = formatLiveRoundUpdate(currentOrLastSession(games));
    assert.ok(msg.includes('*Ronda 1* para *Alfa + Beta*'), msg);
    assert.ok(msg.includes('deben $25'), msg);
});

test('W.O. como primera partida de la ronda: match point', () => {
    // ronda 1 cerrada 2-0, luego un W.O. abre la ronda 2
    const games = merge([game('L', 0), game('L', 10)], [forfeit(1, 20)]);
    const msg = formatLiveRoundUpdate(currentOrLastSession(games));
    assert.ok(msg.includes('Ronda 2'), msg);
    assert.ok(msg.includes('arriba *1-0*'), msg);
    assert.ok(msg.includes('match point'), msg);
});

test('el resumen !rondas muestra la partida como W.O. 1-0', () => {
    const games = merge([game('L', 0)], [forfeit(1, 10)]);
    const msg = formatRondasMessage(currentOrLastSession(games));
    assert.ok(msg.includes('W.O. 1-0'), msg);
});

test('W.O. a favor del equipo que iba perdiendo también cuenta', () => {
    // Alfa+Beta ganan la 1a; luego ELLOS la dan por perdida -> 1-1, la que sigue define
    const games = merge([game('L', 0)], [forfeit(0, 10)]);
    const msg = formatLiveRoundUpdate(currentOrLastSession(games));
    assert.ok(msg.includes('*1-1*'), msg);
    assert.ok(msg.includes('define la ronda'), msg);
});

test('un W.O. anterior al !rondas reset queda fuera del marcador', () => {
    const dir = tmpDir();
    const antes = forfeit(1, 0);
    setResetTs(dir, tsBase + 5 * 60 * 1000); // corte entre el W.O. y la partida real
    const despues = game('L', 10);
    const left = filterGamesAfterReset(merge([despues], [antes]), dir);
    assert.strictEqual(left.length, 1);
    assert.strictEqual(left[0].map_name, 'Guardian');
});

console.log(`\n✅ ${passed} tests OK\n`);
