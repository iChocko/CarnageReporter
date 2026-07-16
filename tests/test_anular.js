/**
 * Tests de la anulación de partidas (!anular): persistencia de anuladas.js
 * y las reglas de validación (quién puede, cooldown, ventana de sesión).
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const anuladas = require('../server/utils/anuladas');

let passed = 0;
function test(name, fn) {
    fn();
    passed++;
    console.log(`  ✅ ${name}`);
}

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wa-anuladas-'));

const NOW = Date.now();
const minAgo = m => new Date(NOW - m * 60 * 1000).toISOString();

function entry(minutesAgo, gameId = 'aaaa1111-0000-0000-0000-000000000000') {
    return { gameId, mapName: 'Heretic', gameTimestamp: minAgo(minutesAgo + 5), annulledAt: minAgo(minutesAgo), by: 'test@c.us' };
}

// Última partida sintética 2v2: [Alfa,Beta] vs [Cyto,Delta], recién jugada
function game(minutesAgo = 2) {
    return {
        game_unique_id: 'bbbb2222-0000-0000-0000-000000000000',
        map_name: 'Guardian',
        timestamp: minAgo(minutesAgo),
        players: [
            { gamertag: 'Alfa', team_id: 0 }, { gamertag: 'Beta', team_id: 0 },
            { gamertag: 'Cyto', team_id: 1 }, { gamertag: 'Delta', team_id: 1 },
        ]
    };
}

console.log('\n— anuladas.js (persistencia) —');

test('archivo faltante o corrupto -> lista vacía sin tronar', () => {
    const dir = tmpDir();
    assert.deepStrictEqual(anuladas.loadAnuladas(dir).anuladas, []);
    fs.writeFileSync(path.join(dir, anuladas.ANULADAS_FILE), 'no-es-json{');
    assert.deepStrictEqual(anuladas.loadAnuladas(dir).anuladas, []);
});

test('round-trip: save, load, y entradas inválidas se descartan', () => {
    const dir = tmpDir();
    const data = { version: 1, anuladas: [entry(10), { basura: true }, { ...entry(5), annulledAt: 'manana' }, entry(1, 'cccc3333')] };
    anuladas.saveAnuladas(dir, data);
    const loaded = anuladas.loadAnuladas(dir);
    assert.strictEqual(loaded.anuladas.length, 2); // basura y timestamp malo se filtraron
    assert.strictEqual(loaded.anuladas[1].gameId, 'cccc3333');
});

console.log('\n— validateAnulacion (reglas) —');

test('sin última partida no hay nada que anular', () => {
    const r = anuladas.validateAnulacion({ game: null, senderTag: 'Alfa', isAdmin: false, lastAnnulledAt: null, now: NOW });
    assert.strictEqual(r.ok, false);
    assert.ok(r.error.includes('No hay partidas'), r.error);
});

test('quien jugó la partida puede anularla (case-insensitive)', () => {
    const r = anuladas.validateAnulacion({ game: game(), senderTag: 'ALFA', isAdmin: false, lastAnnulledAt: null, now: NOW });
    assert.strictEqual(r.ok, true);
});

test('quien no jugó (o no está registrado) no puede; admin sí', () => {
    const ajeno = anuladas.validateAnulacion({ game: game(), senderTag: 'Otro', isAdmin: false, lastAnnulledAt: null, now: NOW });
    assert.strictEqual(ajeno.ok, false);
    assert.ok(ajeno.error.includes('Solo los que jugaron'), ajeno.error);

    const sinTag = anuladas.validateAnulacion({ game: game(), senderTag: null, isAdmin: false, lastAnnulledAt: null, now: NOW });
    assert.strictEqual(sinTag.ok, false);

    const admin = anuladas.validateAnulacion({ game: game(), senderTag: null, isAdmin: true, lastAnnulledAt: null, now: NOW });
    assert.strictEqual(admin.ok, true);
});

test('cooldown: una anulación hace <5 min frena a TODOS (la siguiente partida es real)', () => {
    const r = anuladas.validateAnulacion({ game: game(), senderTag: 'Alfa', isAdmin: true, lastAnnulledAt: minAgo(2), now: NOW });
    assert.strictEqual(r.ok, false);
    assert.ok(r.error.includes('hace un momento'), r.error);
});

test('cooldown vencido (>5 min) ya no estorba', () => {
    const r = anuladas.validateAnulacion({ game: game(), senderTag: 'Alfa', isAdmin: false, lastAnnulledAt: minAgo(6), now: NOW });
    assert.strictEqual(r.ok, true);
});

test('partida fuera de la ventana de sesión: solo admin', () => {
    const vieja = game(200); // gap default 150 min
    const jugador = anuladas.validateAnulacion({ game: vieja, senderTag: 'Alfa', isAdmin: false, lastAnnulledAt: null, now: NOW });
    assert.strictEqual(jugador.ok, false);
    assert.ok(jugador.error.includes('sesión en curso'), jugador.error);

    const admin = anuladas.validateAnulacion({ game: vieja, senderTag: null, isAdmin: true, lastAnnulledAt: null, now: NOW });
    assert.strictEqual(admin.ok, true);
});

test('timestamp que no parsea: partida dudosa, solo admin', () => {
    const rara = { ...game(), timestamp: 'manana' };
    const r = anuladas.validateAnulacion({ game: rara, senderTag: 'Alfa', isAdmin: false, lastAnnulledAt: null, now: NOW });
    assert.strictEqual(r.ok, false);
});

test('la ventana respeta gapMinutes custom', () => {
    const r = anuladas.validateAnulacion({ game: game(20), senderTag: 'Alfa', isAdmin: false, lastAnnulledAt: null, now: NOW, gapMinutes: 10 });
    assert.strictEqual(r.ok, false);
});

console.log(`\n✅ ${passed} tests OK\n`);
