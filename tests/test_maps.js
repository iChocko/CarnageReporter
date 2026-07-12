/**
 * Tests de resolución de mapas:
 *  - server/utils/maps.js  -> resolveMap (prioridades y fallback honesto)
 *  - client/carnage_client -> extracción del código de mapa desde films de autosave
 *  - server/utils/matchSummary -> línea de mapa+gametype para captions
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { resolveMap, MAP_PLACEHOLDER, MAP_UNKNOWN } = require('../server/utils/maps');
const { extractMapCodeFromFilmName, findMapCodeFromFilms } = require('../client/carnage_client');
const { buildCaptionParts } = require('../server/utils/matchSummary');

let passed = 0;
function test(name, fn) {
    fn();
    passed++;
    console.log(`  ✅ ${name}`);
}

console.log('\n— resolveMap —');

test('código conocido -> nombre bonito', () => {
    const r = resolveMap({ mapCode: 'asq_guardia' });
    assert.deepStrictEqual(r, { mapName: 'Guardian', mapCode: 'asq_guardia' });
});

test('código desde filename (clientes viejos)', () => {
    const r = resolveMap({ filename: 'asq_standoff-18-15.xml' });
    assert.deepStrictEqual(r, { mapName: 'Standoff', mapCode: 'asq_standoff' });
});

test('código desconocido -> placeholder + se guarda el código', () => {
    const r = resolveMap({ mapCode: 'asq_lockout' });
    assert.deepStrictEqual(r, { mapName: MAP_PLACEHOLDER, mapCode: 'asq_lockout' });
});

test('sin código, mapName válido del cliente -> respetarlo', () => {
    const r = resolveMap({ mapName: 'Guardian', filename: 'mpcarnagereport_2026.xml' });
    assert.deepStrictEqual(r, { mapName: 'Guardian', mapCode: null });
});

test('sin ningún dato -> "Mapa desconocido" (NUNCA el gametype)', () => {
    const r = resolveMap({ mapName: 'Halo 3 Match', filename: 'mpcarnagereport_2026.xml' });
    assert.deepStrictEqual(r, { mapName: MAP_UNKNOWN, mapCode: null });
});

test('mapName genérico o token "$..." no cuenta como válido', () => {
    assert.strictEqual(resolveMap({ mapName: '$MP_H3_Title' }).mapName, MAP_UNKNOWN);
    assert.strictEqual(resolveMap({ mapName: 'Halo 3 Map' }).mapName, MAP_UNKNOWN);
});

console.log('\n— extractMapCodeFromFilmName —');

test('film con doble hash hex', () => {
    assert.strictEqual(extractMapCodeFromFilmName('asq_warehou_2B3D71C8_6A5319E9.film'), 'asq_warehou');
});

test('temp con un solo hash', () => {
    assert.strictEqual(extractMapCodeFromFilmName('asq_constru_4961F313.temp'), 'asq_constru');
});

test('mapa con guiones bajos en el nombre', () => {
    assert.strictEqual(extractMapCodeFromFilmName('asq_high_ground_AABBCCDD.film'), 'asq_high_ground');
});

test('nombre sin patrón asq_ -> null', () => {
    assert.strictEqual(extractMapCodeFromFilmName('autosave_12345678.film'), null);
});

console.log('\n— findMapCodeFromFilms —');

function makeTempMCC() {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'carnage-test-'));
    fs.mkdirSync(path.join(base, 'Halo3', 'autosave'), { recursive: true });
    return base;
}

test('toma el film más reciente', () => {
    const base = makeTempMCC();
    const dir = path.join(base, 'Halo3', 'autosave');
    fs.writeFileSync(path.join(dir, 'asq_guardia_11111111_22222222.film'), '');
    fs.writeFileSync(path.join(dir, 'asq_chill_33333333_44444444.film'), '');
    const old = Date.now() / 1000 - 3600;
    fs.utimesSync(path.join(dir, 'asq_guardia_11111111_22222222.film'), old, old);
    assert.strictEqual(findMapCodeFromFilms(base), 'asq_chill');
});

test('film demasiado viejo -> null', () => {
    const base = makeTempMCC();
    const dir = path.join(base, 'Halo3', 'autosave');
    const p = path.join(dir, 'asq_guardia_11111111.film');
    fs.writeFileSync(p, '');
    const old = Date.now() / 1000 - 2 * 3600;
    fs.utimesSync(p, old, old);
    assert.strictEqual(findMapCodeFromFilms(base), null);
});

test('sin carpeta autosave -> null (no truena)', () => {
    assert.strictEqual(findMapCodeFromFilms(path.join(os.tmpdir(), 'no-existe-xyz')), null);
});

console.log('\n— buildCaptionParts (línea de mapa) —');

const basePlayers = [
    { gamertag: 'A', teamId: 0, score: 50 },
    { gamertag: 'B', teamId: 1, score: 40 }
];

test('mapa real + gametype distinto -> "Mapa · Gametype"', () => {
    const parts = buildCaptionParts({
        mapName: 'Guardian', gameTypeName: '2V2 HARDCORE TS',
        timestamp: Date.now(), gameUniqueId: 'abc12345-x'
    }, basePlayers);
    assert.strictEqual(parts.mapLine, 'Guardian · 2V2 HARDCORE TS');
});

test('gametype con token "$..." no se agrega', () => {
    const parts = buildCaptionParts({
        mapName: 'Guardian', gameTypeName: '$MP_TOKEN',
        timestamp: Date.now(), gameUniqueId: 'abc12345-x'
    }, basePlayers);
    assert.strictEqual(parts.mapLine, 'Guardian');
});

console.log(`\n✅ ${passed} tests OK\n`);
