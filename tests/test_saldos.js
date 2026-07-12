/**
 * Tests del corte semanal de saldos (computeSaldos + formatSaldosMessage):
 * neteo por alineación a través de varias sesiones, deudas por equipo y
 * mensaje con menciones.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    computeSaldos, formatSaldosMessage, getLastCorteTs, setLastCorteTs, isSameCdmxDay
} = require('../server/utils/saldos');

let passed = 0;
function test(name, fn) {
    fn();
    passed++;
    console.log(`  ✅ ${name}`);
}

// Partida sintética 2v2 en un instante dado (minutos desde una base fija).
const tsBase = Date.parse('2026-07-07T20:00:00.000Z');
function game(a, b, c, d, winner, minutesAfter) {
    const [sL, sR] = winner === 'L' ? [50, 40] : winner === 'R' ? [40, 50] : [45, 45];
    return {
        timestamp: new Date(tsBase + minutesAfter * 60 * 1000).toISOString(),
        map_name: 'Guardian',
        players: [
            { gamertag: a, team_id: 0, score: sL / 2 }, { gamertag: b, team_id: 0, score: sL / 2 },
            { gamertag: c, team_id: 1, score: sR / 2 }, { gamertag: d, team_id: 1, score: sR / 2 },
        ]
    };
}

// Ronda completa (primera a 2) para el lado izquierdo o derecho
const ronda = (a, b, c, d, winner, start) => [
    game(a, b, c, d, winner, start), game(a, b, c, d, winner, start + 8),
];

console.log('\n— computeSaldos —');

test('una sesión, una alineación: la diferencia neta de rondas paga', () => {
    // Alfa+Beta ganan 2 rondas, Cyto+Delta 1 -> deben $25
    const games = [
        ...ronda('Alfa', 'Beta', 'Cyto', 'Delta', 'L', 0),
        ...ronda('Alfa', 'Beta', 'Cyto', 'Delta', 'R', 20),
        ...ronda('Alfa', 'Beta', 'Cyto', 'Delta', 'L', 40),
    ];
    const saldos = computeSaldos(games);
    assert.strictEqual(saldos.length, 1);
    assert.deepStrictEqual(new Set(saldos[0].winners), new Set(['Alfa', 'Beta']));
    assert.deepStrictEqual(new Set(saldos[0].losers), new Set(['Cyto', 'Delta']));
    assert.strictEqual(saldos[0].amount, 25);
});

test('misma alineación en dos sesiones distintas: se netea en una sola línea', () => {
    // Martes: Alfa+Beta arriba 2-0. Viernes (>150 min después): Cyto+Delta ganan 1.
    const martes = [
        ...ronda('Alfa', 'Beta', 'Cyto', 'Delta', 'L', 0),
        ...ronda('Alfa', 'Beta', 'Cyto', 'Delta', 'L', 20),
    ];
    const viernes = [
        ...ronda('Alfa', 'Beta', 'Cyto', 'Delta', 'R', 3000),
    ];
    const saldos = computeSaldos([...martes, ...viernes]);
    assert.strictEqual(saldos.length, 1);
    assert.strictEqual(saldos[0].amount, 25); // 2 - 1 = 1 ronda neta
    assert.deepStrictEqual(new Set(saldos[0].winners), new Set(['Alfa', 'Beta']));
});

test('alineaciones distintas van por separado (aunque repitan personas)', () => {
    const retaUno = ronda('Alfa', 'Beta', 'Cyto', 'Delta', 'L', 0);      // ganan Alfa+Beta
    const retaDos = ronda('Alfa', 'Cyto', 'Beta', 'Delta', 'R', 3000);   // ganan Beta+Delta
    const saldos = computeSaldos([...retaUno, ...retaDos]);
    assert.strictEqual(saldos.length, 2);
    const amounts = saldos.map(s => s.amount);
    assert.deepStrictEqual(amounts, [25, 25]);
});

test('alineación a mano no aparece; ronda a medias no cuenta', () => {
    const games = [
        ...ronda('Alfa', 'Beta', 'Cyto', 'Delta', 'L', 0),
        ...ronda('Alfa', 'Beta', 'Cyto', 'Delta', 'R', 20),
        game('Alfa', 'Beta', 'Cyto', 'Delta', 'L', 40), // ronda abierta 1-0: no suma
    ];
    assert.deepStrictEqual(computeSaldos(games), []);
});

test('el de mayor deuda va primero', () => {
    const retaUno = [
        ...ronda('Alfa', 'Beta', 'Cyto', 'Delta', 'L', 0),
        ...ronda('Alfa', 'Beta', 'Cyto', 'Delta', 'L', 20),
    ]; // $50
    const retaDos = ronda('Eco', 'Fox', 'Golf', 'Hotel', 'L', 3000); // $25
    const saldos = computeSaldos([...retaUno, ...retaDos]);
    assert.strictEqual(saldos[0].amount, 50);
    assert.strictEqual(saldos[1].amount, 25);
});

console.log('\n— formatSaldosMessage —');

test('sin partidas pendientes -> null (no hay corte que anunciar)', () => {
    assert.strictEqual(formatSaldosMessage([], 0, new Map()), null);
});

test('con partidas pero a mano -> mensaje "a mano" y sin menciones', () => {
    const out = formatSaldosMessage([], 8, new Map());
    assert.ok(out.text.includes('*CORTE SEMANAL*'), out.text);
    assert.ok(out.text.includes('a mano'), out.text);
    assert.ok(out.text.includes('Marcador en ceros'), out.text);
    assert.deepStrictEqual(out.mentions, []);
});

test('deudas con menciones para los del roster y texto plano para el resto', () => {
    const saldos = computeSaldos([
        ...ronda('Alfa', 'Beta', 'Cyto', 'Delta', 'L', 0),
    ]);
    const map = new Map([
        ['alfa', '5215500000001@c.us'],
        ['cyto', '5215500000002@c.us'],
    ]);
    const out = formatSaldosMessage(saldos, 2, map);
    assert.ok(out.text.includes('@5215500000001'), out.text);
    assert.ok(out.text.includes('@5215500000002'), out.text);
    assert.ok(out.text.includes('Beta'), out.text);   // sin JID: texto plano
    assert.ok(out.text.includes('Delta'), out.text);
    assert.ok(out.text.includes('deben *$25*'), out.text);
    assert.ok(out.text.includes('Hoy se saldan'), out.text);
    assert.deepStrictEqual(new Set(out.mentions), new Set(['5215500000001@c.us', '5215500000002@c.us']));
});

test('los W.O. (partidas virtuales) también suman al corte', () => {
    const forfeits = require('../server/utils/forfeits');
    const wo = forfeits.forfeitToGame({
        timestamp: new Date(tsBase + 16 * 60 * 1000).toISOString(),
        sides: [['Alfa', 'Beta'], ['Cyto', 'Delta']],
        loserSide: 1,
    });
    // partida real + W.O. cierran la ronda 2-0 para Alfa+Beta
    const games = [game('Alfa', 'Beta', 'Cyto', 'Delta', 'L', 0), wo]
        .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    const saldos = computeSaldos(games);
    assert.strictEqual(saldos.length, 1);
    assert.strictEqual(saldos[0].amount, 25);
    assert.deepStrictEqual(new Set(saldos[0].losers), new Set(['Cyto', 'Delta']));
});

test('gamertag no registrado que empieza con "@" se sanitiza (no finge mención)', () => {
    const saldos = computeSaldos([
        ...ronda('@5219990000000 *FALSO*', 'Beta', 'Cyto', 'Delta', 'L', 0),
    ]);
    const out = formatSaldosMessage(saldos, 2, new Map([['beta', '5215500000009@c.us']]));
    assert.ok(!out.text.includes('@5219990000000'), out.text); // el @ se limpió
    assert.ok(!out.text.includes('*FALSO*'), out.text);        // el markdown se limpió
    assert.ok(out.text.includes('@5215500000009'), out.text);  // la mención real sí sale
    assert.deepStrictEqual(out.mentions, ['5215500000009@c.us']);
});

console.log('\n— marcador del corte diario —');

test('getLastCorteTs: sin archivo o corrupto -> null; round-trip funciona', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'saldos-corte-'));
    assert.strictEqual(getLastCorteTs(dir), null);
    fs.writeFileSync(path.join(dir, 'saldos_corte.json'), 'no-json{');
    assert.strictEqual(getLastCorteTs(dir), null);
    const ts = setLastCorteTs(dir, 1234567890000);
    assert.strictEqual(getLastCorteTs(dir), ts);
});

test('isSameCdmxDay respeta la zona horaria de CDMX', () => {
    // 04:00 UTC y 05:59 UTC del mismo día = 22:00 y 23:59 CDMX del día ANTERIOR
    const a = Date.parse('2026-07-13T04:00:00.000Z'); // 12-jul 22:00 CDMX
    const b = Date.parse('2026-07-13T05:59:00.000Z'); // 12-jul 23:59 CDMX
    const c = Date.parse('2026-07-13T06:01:00.000Z'); // 13-jul 00:01 CDMX
    assert.ok(isSameCdmxDay(a, b));
    assert.ok(!isSameCdmxDay(b, c));
});

console.log(`\n✅ ${passed} tests OK\n`);
