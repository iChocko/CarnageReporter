/**
 * Tests de client/src/parser.js: mapeo de campos del XML de carnage report,
 * medallas, duración, raíz de un solo jugador, código de mapa desde films
 * de autosave, y timestamp desde el nombre del archivo.
 */

const { test } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    parseXML, parseTimestampFromFilename, extractMapCodeFromFilmName, findMapCodeFromFilms, toBool,
    toIsoWithOffset
} = require('../src/parser');

const FIXTURES_DIR = path.join(__dirname, 'fixtures');

// Copia un fixture (y opcionalmente el film de autosave) a un directorio
// temporal para ejercitar el flujo real de lectura de disco de parseXML.
function loadFixture(name, { withFilm = false } = {}) {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'carnage-parser-test-'));
    if (withFilm) {
        const autosaveDir = path.join(base, 'Halo3', 'autosave');
        fs.mkdirSync(autosaveDir, { recursive: true });
        const filmDest = path.join(autosaveDir, 'asq_warehou_2B3D71C8_6A5319E9.film');
        fs.copyFileSync(
            path.join(FIXTURES_DIR, 'Halo3', 'autosave', 'asq_warehou_2B3D71C8_6A5319E9.film'),
            filmDest
        );
        // copyFileSync conserva el mtime del fixture (fecha del checkout); el
        // film debe verse "reciente" (< 30 min) o findMapCodeFromFilms lo ignora
        // y el test falla en cualquier checkout con más de media hora.
        const now = new Date();
        fs.utimesSync(filmDest, now, now);
    }
    const dest = path.join(base, name);
    fs.copyFileSync(path.join(FIXTURES_DIR, name), dest);
    return dest;
}

console.log('\n— parseXML: mapeo de campos (2v2) —');

test('mapea gameData y jugadores correctamente', () => {
    const filePath = loadFixture('mpcarnagereport_2v2.xml', { withFilm: true });
    const { gameData, players } = parseXML(filePath);

    assert.strictEqual(gameData.gameUniqueId, '2v2-fixture-0001');
    assert.strictEqual(gameData.gameTypeName, 'SLAYER');
    assert.strictEqual(gameData.partySize, 2);
    // fast-xml-parser coerce "true"/"false" a booleanos reales: hay que
    // verificar que isMatchmaking/isTeamsEnabled queden en el valor correcto,
    // no siempre en false por comparar contra el string 'true'.
    assert.strictEqual(gameData.isTeamsEnabled, true);
    assert.strictEqual(gameData.isMatchmaking, false);
    assert.strictEqual(players.length, 4);

    const alpha = players.find(p => p.gamertag === 'PlayerAlpha');
    assert.strictEqual(alpha.xboxUserId, 'xuid-alpha');
    assert.strictEqual(alpha.clanTag, 'H3');
    assert.strictEqual(alpha.teamId, 0);
    assert.strictEqual(alpha.score, 25);
    assert.strictEqual(alpha.kills, 25);
    assert.strictEqual(alpha.deaths, 10);
    assert.strictEqual(alpha.assists, 5);
    assert.strictEqual(alpha.secondsPlayed, 610);
    assert.strictEqual(alpha.completedGame, 1);
    assert.strictEqual(alpha.killsWeapon, 20);
    assert.strictEqual(alpha.isGuest, false);
});

test('solo cuenta medallas con conteo > 0', () => {
    const filePath = loadFixture('mpcarnagereport_2v2.xml', { withFilm: true });
    const { players } = parseXML(filePath);

    const alpha = players.find(p => p.gamertag === 'PlayerAlpha');
    // El fixture trae 3 medallas para Alpha, una con mCount=0 (se filtra)
    assert.strictEqual(alpha.medals.length, 2);
    assert.deepStrictEqual(alpha.medals, [{ id: 1, count: 3 }, { id: 3, count: 1 }]);

    const bravo = players.find(p => p.gamertag === 'PlayerBravo');
    // Bravo solo trae una medalla con conteo 0: debe quedar sin medallas
    assert.strictEqual(bravo.medals.length, 0);
});

test('la duración de la partida es el mayor secondsPlayed entre jugadores', () => {
    const filePath = loadFixture('mpcarnagereport_2v2.xml', { withFilm: true });
    const { gameData } = parseXML(filePath);
    // Charlie tiene 615s, el resto menos
    assert.strictEqual(gameData.duration, 615);
});

console.log('\n— parseXML: raíz de un solo jugador —');

test('Players.Player como nodo único (no arreglo) se normaliza a lista de 1', () => {
    const filePath = loadFixture('mpcarnagereport_single_player.xml');
    const { players, gameData } = parseXML(filePath);

    assert.strictEqual(players.length, 1);
    assert.strictEqual(players[0].gamertag, 'LoneWolf');
    assert.strictEqual(gameData.gameUniqueId, 'solo-fixture-0001');
});

console.log('\n— parseXML: XML incompleto —');

test('campos ausentes en el XML no truenan y caen a sus defaults', () => {
    const filePath = loadFixture('mpcarnagereport_incomplete.xml');
    const { gameData, players } = parseXML(filePath);

    assert.strictEqual(gameData.gameUniqueId, 'incomplete-fixture-0001');
    assert.strictEqual(gameData.gameTypeName, 'Slayer'); // default cuando falta GameTypeName
    assert.strictEqual(players.length, 1);
    assert.strictEqual(players[0].gamertag, 'Ghost');
    assert.strictEqual(players[0].xboxUserId, '');
    assert.strictEqual(players[0].kills, 0);
    assert.strictEqual(players[0].completedGame, null); // mCompletedGame ausente -> null, no 0
    assert.deepStrictEqual(players[0].medals, []);
    // El servidor anula la partida con reason=last_match_incomplete cuando
    // esto es true: debe llegar en true de verdad, no siempre false por
    // comparar contra el string 'true' (fast-xml-parser ya lo da booleano).
    assert.strictEqual(gameData.lastMatchIncomplete, true);
});

console.log('\n— código de mapa desde el film de autosave (parseXML) —');

test('con un film reciente junto al XML, mapCode y mapName vienen del film', () => {
    const filePath = loadFixture('mpcarnagereport_2v2.xml', { withFilm: true });
    const { gameData } = parseXML(filePath);
    assert.strictEqual(gameData.mapCode, 'asq_warehou');
    assert.strictEqual(gameData.mapName, 'Amplified');
});

test('sin film de autosave, mapCode queda null y se usa el nombre del hopper/XML', () => {
    const filePath = loadFixture('mpcarnagereport_2v2.xml', { withFilm: false });
    const { gameData } = parseXML(filePath);
    assert.strictEqual(gameData.mapCode, null);
});

console.log('\n— extractMapCodeFromFilmName —');

test('film con doble hash hex', () => {
    assert.strictEqual(extractMapCodeFromFilmName('asq_warehou_2B3D71C8_6A5319E9.film'), 'asq_warehou');
});

test('nombre sin patrón asq_ -> null', () => {
    assert.strictEqual(extractMapCodeFromFilmName('autosave_12345678.film'), null);
});

console.log('\n— findMapCodeFromFilms: corte de 30 minutos —');

function makeTempMCC() {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'carnage-films-test-'));
    fs.mkdirSync(path.join(base, 'Halo3', 'autosave'), { recursive: true });
    return base;
}

test('film reciente (dentro de 30 min) sí cuenta', () => {
    const base = makeTempMCC();
    const filmPath = path.join(base, 'Halo3', 'autosave', 'asq_guardia_11111111.film');
    fs.writeFileSync(filmPath, '');
    assert.strictEqual(findMapCodeFromFilms(base), 'asq_guardia');
});

test('film de más de 30 min de antigüedad se descarta', () => {
    const base = makeTempMCC();
    const filmPath = path.join(base, 'Halo3', 'autosave', 'asq_guardia_11111111.film');
    fs.writeFileSync(filmPath, '');
    const old = Date.now() / 1000 - 31 * 60;
    fs.utimesSync(filmPath, old, old);
    assert.strictEqual(findMapCodeFromFilms(base), null);
});

test('film de justo 29 minutos (dentro del corte) sí cuenta', () => {
    const base = makeTempMCC();
    const filmPath = path.join(base, 'Halo3', 'autosave', 'asq_guardia_11111111.film');
    fs.writeFileSync(filmPath, '');
    const withinCutoff = Date.now() / 1000 - 29 * 60;
    fs.utimesSync(filmPath, withinCutoff, withinCutoff);
    assert.strictEqual(findMapCodeFromFilms(base), 'asq_guardia');
});

console.log('\n— parseTimestampFromFilename —');

test('extrae fecha y hora local del nombre del archivo', () => {
    const ts = parseTimestampFromFilename('mpcarnagereport-2026-01-15-08-30-45.xml');
    assert.strictEqual(ts.getFullYear(), 2026);
    assert.strictEqual(ts.getMonth(), 0); // enero = 0
    assert.strictEqual(ts.getDate(), 15);
    assert.strictEqual(ts.getHours(), 8);
    assert.strictEqual(ts.getMinutes(), 30);
    assert.strictEqual(ts.getSeconds(), 45);
});

test('sin patrón de fecha en el nombre -> usa la hora actual', () => {
    const before = Date.now();
    const ts = parseTimestampFromFilename('mpcarnagereport.xml');
    const after = Date.now();
    assert.ok(ts.getTime() >= before && ts.getTime() <= after);
});

console.log('\n— toBool —');

test('toBool acepta booleano real, string y numérico, en ambos sentidos', () => {
    assert.strictEqual(toBool(true), true);
    assert.strictEqual(toBool('true'), true);
    assert.strictEqual(toBool(1), true);
    assert.strictEqual(toBool('1'), true);
    assert.strictEqual(toBool(false), false);
    assert.strictEqual(toBool('false'), false);
    assert.strictEqual(toBool(0), false);
    assert.strictEqual(toBool('0'), false);
    assert.strictEqual(toBool(undefined), false);
    assert.strictEqual(toBool(null), false);
});

console.log('\n— toIsoWithOffset (Fase B3: timestamp con zona horaria) —');

function expectedOffsetSuffix(date) {
    const offsetMin = -date.getTimezoneOffset();
    const sign = offsetMin >= 0 ? '+' : '-';
    const pad = n => String(Math.abs(n)).padStart(2, '0');
    return `${sign}${pad(Math.floor(Math.abs(offsetMin) / 60))}:${pad(Math.abs(offsetMin) % 60)}`;
}

test('tiene la forma YYYY-MM-DDTHH:mm:ss±HH:MM', () => {
    const d = new Date(2026, 8, 6, 21, 15, 0); // 6 de septiembre de 2026, 21:15:00 local
    const iso = toIsoWithOffset(d);
    assert.match(iso, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
    assert.ok(iso.startsWith('2026-09-06T21:15:00'));
});

test('el offset coincide con el de la máquina que corre la prueba', () => {
    const d = new Date(2026, 0, 15, 8, 30, 0);
    const iso = toIsoWithOffset(d);
    assert.ok(iso.endsWith(expectedOffsetSuffix(d)), `esperaba que ${iso} terminara en ${expectedOffsetSuffix(d)}`);
});

test('round-trip: parsear el ISO con offset da el mismo instante UTC que el Date original', () => {
    const d = new Date(2026, 5, 1, 3, 7, 42);
    const iso = toIsoWithOffset(d);
    assert.strictEqual(new Date(iso).getTime(), d.getTime());
});

test('rellena con ceros minutos/segundos/horas de un solo dígito', () => {
    const d = new Date(2026, 0, 5, 1, 2, 3);
    const iso = toIsoWithOffset(d);
    assert.ok(iso.startsWith('2026-01-05T01:02:03'));
});

console.log('\n— parseXML: timestamp v3 (ISO con offset + timestampLocal) —');

test('gameData.timestamp es un string ISO con offset, no un Date; timestampLocal conserva el string crudo', () => {
    const filePath = loadFixture('mpcarnagereport_2v2.xml', { withFilm: true });
    // Este fixture no trae fecha en el nombre de archivo (usa un nombre fijo
    // de prueba), así que se renombra a uno con timestamp real para probar.
    const dir = path.dirname(filePath);
    const renamed = path.join(dir, 'mpcarnagereport-2026-03-10-19-05-30.xml');
    fs.renameSync(filePath, renamed);

    const { gameData } = parseXML(renamed);

    assert.strictEqual(typeof gameData.timestamp, 'string');
    assert.match(gameData.timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
    assert.ok(gameData.timestamp.startsWith('2026-03-10T19:05:30'));
    assert.strictEqual(gameData.timestampLocal, '2026-03-10-19-05-30');
});

test('sin patrón de fecha en el nombre -> timestampLocal es null, timestamp sigue siendo ISO con offset', () => {
    const filePath = loadFixture('mpcarnagereport_single_player.xml');
    const { gameData } = parseXML(filePath);
    assert.strictEqual(gameData.timestampLocal, null);
    assert.match(gameData.timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
});
