/**
 * Tests del matchmaking por menciones: roster persistente (roster.js),
 * récords de duplas, rating mezclado, ranking de emparejamientos y
 * validación/limpieza del comando !equipos.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const roster = require('../server/utils/roster');
const { computeDuoRecords, aggregatePlayers } = require('../server/utils/records');
const teams = require('../server/utils/teams');

let passed = 0;
function test(name, fn) {
    fn();
    passed++;
    console.log(`  ✅ ${name}`);
}

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wa-roster-'));

// Partida sintética 2v2: [A,B] vs [C,D]; gana el lado con más score.
function game(a, b, c, d, scoreL, scoreR, stats = {}) {
    const p = (tag, team, score) => ({
        gamertag: tag, team_id: team, score,
        kills: stats.kills ?? score, deaths: stats.deaths ?? 10,
        assists: stats.assists ?? 3, most_kills_in_a_row: stats.spree ?? 4,
    });
    return {
        timestamp: new Date().toISOString(),
        map_name: 'Guardian',
        players: [p(a, 0, scoreL / 2), p(b, 0, scoreL / 2), p(c, 1, scoreR / 2), p(d, 1, scoreR / 2)]
    };
}

console.log('\n— roster.js —');

test('archivo faltante o corrupto -> roster vacío sin tronar', () => {
    const dir = tmpDir();
    assert.deepStrictEqual(roster.loadRoster(dir).links, []);
    fs.writeFileSync(path.join(dir, roster.ROSTER_FILE), 'no-es-json{');
    assert.deepStrictEqual(roster.loadRoster(dir).links, []);
});

test('round-trip: link, save, load, findByJid/findByGamertag', () => {
    const dir = tmpDir();
    const data = roster.loadRoster(dir);
    const r = roster.linkJid(data, '5215554353385@c.us', 'Rober K15 Mx', { known: true, by: 'admin' });
    assert.ok(r.ok);
    roster.saveRoster(dir, data);

    const loaded = roster.loadRoster(dir);
    assert.strictEqual(roster.findByJid(loaded, '5215554353385@c.us').gamertag, 'Rober K15 Mx');
    assert.strictEqual(roster.findByGamertag(loaded, 'rober k15 mx').jids[0], '5215554353385@c.us');
});

test('addAlias aprende la otra forma de JID y ambas resuelven', () => {
    const data = { version: 1, links: [] };
    const { link } = roster.linkJid(data, '5215554353385@c.us', 'Rober K15 Mx', {});
    roster.addAlias(link, '111222333@lid');
    roster.addAlias(link, '111222333@lid'); // idempotente
    assert.strictEqual(link.jids.length, 2);
    assert.strictEqual(roster.findByJid(data, '111222333@lid').gamertag, 'Rober K15 Mx');
});

test('re-link del mismo JID sobrescribe y reporta el tag anterior', () => {
    const data = { version: 1, links: [] };
    roster.linkJid(data, 'x@c.us', 'TagViejo', {});
    const r = roster.linkJid(data, 'x@c.us', 'TagNuevo', {});
    assert.ok(r.ok);
    assert.strictEqual(r.previous, 'TagViejo');
    assert.strictEqual(data.links.length, 1);
});

test('tag reclamado por otro JID -> conflicto, no toca nada', () => {
    const data = { version: 1, links: [] };
    roster.linkJid(data, 'a@c.us', 'Axtorion', {});
    const r = roster.linkJid(data, 'b@c.us', 'axtorion', {});
    assert.ok(!r.ok);
    assert.strictEqual(r.conflict.gamertag, 'Axtorion');
    assert.strictEqual(data.links.length, 1);
});

test('unlinkGamertag quita el vínculo (case-insensitive)', () => {
    const data = { version: 1, links: [] };
    roster.linkJid(data, 'a@c.us', 'Axtorion', {});
    assert.ok(roster.unlinkGamertag(data, 'AXTORION'));
    assert.ok(!roster.unlinkGamertag(data, 'Axtorion'));
    assert.strictEqual(data.links.length, 0);
});

test('matchGamertag: exacto, typo (Levenshtein), substring, desconocido', () => {
    const known = new Map([
        ['axtorion', 'Axtorion'],
        ['rober k15 mx', 'Rober K15 Mx'],
        ['lchocko', 'lChocko'],
    ]);
    assert.strictEqual(roster.matchGamertag('AXTORION', known).exact, 'Axtorion');
    assert.strictEqual(roster.matchGamertag('Axtorio', known).suggestion, 'Axtorion');
    assert.strictEqual(roster.matchGamertag('rober', known).suggestion, 'Rober K15 Mx');
    assert.ok(roster.matchGamertag('ZzXxYy99', known).unknown);
});

test('matchGamertag: entradas gigantes no se comparan (unknown directo)', () => {
    const known = new Map([['axtorion', 'Axtorion']]);
    assert.ok(roster.matchGamertag('x'.repeat(60000), known).unknown);
});

console.log('\n— computeDuoRecords —');

test('duplas ganadora y perdedora en una pasada', () => {
    const duos = computeDuoRecords([
        game('A', 'B', 'C', 'D', 50, 40),
        game('A', 'B', 'C', 'D', 50, 40),
        game('C', 'D', 'A', 'B', 50, 40),
    ]);
    assert.deepStrictEqual(duos.get('a|b'), { games: 3, wins: 2, losses: 1, draws: 0 });
    assert.deepStrictEqual(duos.get('c|d'), { games: 3, wins: 1, losses: 2, draws: 0 });
});

console.log('\n— rating mezclado (computeSkillIndex) —');

test('mismo desempeño individual pero más victorias -> mejor rating', () => {
    // A y C con stats individuales idénticos; A gana 3-0, C pierde 3-0
    const games = [
        game('A', 'B', 'C', 'D', 50, 40, { kills: 20, deaths: 10 }),
        game('A', 'B', 'C', 'D', 50, 40, { kills: 20, deaths: 10 }),
        game('A', 'B', 'C', 'D', 50, 40, { kills: 20, deaths: 10 }),
    ];
    const idx = teams.computeSkillIndex(games);
    assert.ok(idx.byLower.get('a').score > idx.byLower.get('c').score,
        `A=${idx.byLower.get('a').score} vs C=${idx.byLower.get('c').score}`);
});

console.log('\n— duoAdjustment / rankPairings —');

test('dupla con <3 partidas juntos no ajusta; con >=3 sí', () => {
    const duos = new Map([
        ['a|b', { games: 2, wins: 2, losses: 0, draws: 0 }],
        ['c|d', { games: 5, wins: 4, losses: 1, draws: 0 }],
    ]);
    assert.strictEqual(teams.duoAdjustment('A', 'B', duos), 0);
    const adj = teams.duoAdjustment('C', 'D', duos);
    assert.ok(adj > 0 && adj <= 5, String(adj));
});

test('rankPairings devuelve las 3 opciones ordenadas de más pareja a menos', () => {
    const r4 = [
        { name: 'Crack', skill: 90, estimated: false },
        { name: 'Bueno', skill: 70, estimated: false },
        { name: 'Medio', skill: 60, estimated: false },
        { name: 'Nuevo', skill: 40, estimated: true },
    ];
    const ranked = teams.rankPairings(r4);
    assert.strictEqual(ranked.length, 3);
    // La más pareja: Crack+Nuevo (130) vs Bueno+Medio (130)
    const best = [...ranked[0].teamA, ...ranked[0].teamB].map(p => p.name);
    assert.deepStrictEqual(new Set([best[0], best[1]]), new Set(['Crack', 'Nuevo']));
    assert.ok(ranked[0].cost <= ranked[1].cost && ranked[1].cost <= ranked[2].cost);
    assert.strictEqual(ranked[0].balancePct, 100);
});

test('formatPairingsMessage: solo la mejor propuesta, sin números ni alternativas', () => {
    const r4 = [
        { name: 'Crack', skill: 90, estimated: false },
        { name: 'Bueno', skill: 70, estimated: false },
        { name: 'Medio', skill: 60, estimated: false },
        { name: 'Nuevo', skill: 40, estimated: true },
    ];
    const ranked = teams.rankPairings(r4);
    const msg = teams.formatPairingsMessage(r4, ranked);
    assert.ok(msg.includes('*RETA 2v2*'), msg);
    // La más pareja: Crack+Nuevo (130) vs Bueno+Medio (130)
    assert.ok(msg.includes('Crack') && msg.includes('Nuevo'), msg);
    assert.ok(msg.includes('Bueno') && msg.includes('Medio'), msg);
    // Sin números, porcentajes ni alternativas — solo el corte
    assert.ok(!msg.includes('%'), msg);
    assert.ok(!msg.includes('fuerza'), msg);
    assert.ok(!/\(\d/.test(msg), msg); // sin "(90)" ni similares
    assert.ok(!msg.includes('Otras opciones'), msg);
    assert.ok(!msg.includes('Rating provisional'), msg);
    assert.ok(!msg.includes('Dupla con historial'), msg);
});

console.log('\n— validateRoster / stripMentionTokens —');

test('modo exact:4 exige exactamente 4', () => {
    const v3 = teams.validateRoster(['A', 'B', 'C'], { exact: 4 });
    assert.ok(!v3.ok && v3.error.includes('exactamente 4'), v3.error);
    const v5 = teams.validateRoster(['A', 'B', 'C', 'D', 'E'], { exact: 4 });
    assert.ok(!v5.ok && v5.error.includes('diste 5'), v5.error);
    const v4 = teams.validateRoster(['A', 'B', 'C', 'D'], { exact: 4 });
    assert.ok(v4.ok);
});

test('repetidos en modo exact:4 -> mensaje de repetidos', () => {
    const v = teams.validateRoster(['A', 'B', 'a', 'C'], { exact: 4 });
    assert.ok(!v.ok && v.error.includes('repetidos'), v.error);
    assert.ok(v.error.includes('me quedaron 3'), v.error);
});

test('sin exact: se mantiene el flujo par 4-16 (4v4 y listas escritas)', () => {
    assert.ok(teams.validateRoster(['A', 'B', 'C', 'D', 'E', 'F']).ok);
    const impar = teams.validateRoster(['A', 'B', 'C', 'D', 'E']);
    assert.ok(!impar.ok && impar.error.includes('impar'), impar.error);
    const pocos = teams.validateRoster(['A', 'B']);
    assert.ok(!pocos.ok && pocos.error.includes('Mínimo 4'), pocos.error);
});

test('stripMentionTokens quita @dígitos y respeta gamertags escritos', () => {
    const clean = teams.stripMentionTokens('@5215554353385 @5219611132809 Fulano, Invitado X');
    assert.strictEqual(clean, 'Fulano, Invitado X');
    assert.strictEqual(teams.stripMentionTokens('@123 @456'), '');
    assert.strictEqual(teams.stripMentionTokens(''), '');
});

test('parsePlayerList tras limpiar tokens no inventa jugadores', () => {
    const known = new Map([['fulano', 'Fulano']]);
    const names = teams.parsePlayerList(teams.stripMentionTokens('@521555 Fulano'), known);
    assert.deepStrictEqual(names, ['Fulano']);
});

console.log('\n— menciones en la respuesta (playerDisplay) —');

test('playerDisplay: token @dígitos con JID, texto plano sin él', () => {
    const map = new Map([['axtorion', '5215564168735@c.us']]);
    assert.strictEqual(teams.playerDisplay('Axtorion', map), '@5215564168735');
    assert.strictEqual(teams.playerDisplay('Invitado', map), 'Invitado');
    assert.strictEqual(teams.playerDisplay('Axtorion'), 'Axtorion');
});

test('formatPairingsMessage menciona a los del roster y deja invitados en texto', () => {
    const r4 = [
        { name: 'Axtorion', skill: 60, estimated: false },
        { name: 'lChocko', skill: 49, estimated: false },
        { name: 'Rober K15 Mx', skill: 52, estimated: false },
        { name: 'Invitado', skill: 40, estimated: true },
    ];
    const map = new Map([
        ['axtorion', '5215564168735@c.us'],
        ['lchocko', '5215535257707@c.us'],
        ['rober k15 mx', '5215543535385@c.us'],
    ]);
    const msg = teams.formatPairingsMessage(r4, teams.rankPairings(r4), map);
    assert.ok(msg.includes('@5215564168735'), msg);
    assert.ok(msg.includes('@5215535257707'), msg);
    assert.ok(msg.includes('@5215543535385'), msg);
    assert.ok(msg.includes('Invitado'), msg);
    assert.ok(!msg.includes('Axtorion'), msg); // el mencionado ya no sale por gamertag
});

console.log('\n— resolveRoster (jugadores nuevos) —');

test('jugador sin partidas queda con la media y marcado como estimado', () => {
    const games = [
        game('A', 'B', 'C', 'D', 50, 40, { kills: 20, deaths: 10 }),
    ];
    const idx = teams.computeSkillIndex(games);
    const r = teams.resolveRoster(['A', 'JugadorNuevo'], idx, null);
    const nuevo = r.find(p => p.name === 'JugadorNuevo');
    assert.ok(nuevo.estimated);
    assert.ok(Math.abs(nuevo.skill - idx.mean) < 1e-9);
});

console.log(`\n✅ ${passed} tests OK\n`);
