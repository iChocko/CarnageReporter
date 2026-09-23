/**
 * Tests de services/supabase.js _gamesWithPlayers con un cliente fake que
 * imita el tope `max-rows` de PostgREST (1000 filas por respuesta, sin
 * error ni aviso): getAllValidGamesWithPlayers debe traer TODAS las
 * partidas y TODOS sus jugadores, no solo las primeras 1000 filas.
 */

'use strict';

const { test } = require('node:test');
const assert = require('assert');

const SupabaseService = require('../services/supabase');

/** Query builder "thenable" mínimo con la semántica de PostgREST que usa el servicio. */
function makeFakeClient(tables, { maxRows = 1000 } = {}) {
    const requests = [];
    const client = {
        from(table) {
            const q = { table, cols: [], count: false, filters: [], order: [], limit: null, range: null };
            const builder = {
                select(cols, opts) {
                    q.cols = cols.split(',').map(s => s.trim());
                    q.count = opts?.count === 'exact';
                    return builder;
                },
                eq(col, val) { q.filters.push(r => r[col] === val); return builder; },
                in(col, vals) {
                    const set = new Set(vals);
                    q.filters.push(r => set.has(r[col]));
                    return builder;
                },
                order(col, { ascending = true } = {}) { q.order.push({ col, ascending }); return builder; },
                limit(n) { q.limit = n; return builder; },
                range(from, to) { q.range = [from, to]; return builder; },
                then(resolve, reject) {
                    try {
                        requests.push(q);
                        const rows = (tables[table] || []).filter(r => q.filters.every(f => f(r)));
                        rows.sort((a, b) => {
                            for (const { col, ascending } of q.order) {
                                if (a[col] < b[col]) return ascending ? -1 : 1;
                                if (a[col] > b[col]) return ascending ? 1 : -1;
                            }
                            return 0;
                        });
                        const start = q.range ? q.range[0] : 0;
                        const wantedEnd = q.range ? q.range[1] + 1 : (q.limit ?? rows.length);
                        const end = Math.min(wantedEnd, start + maxRows); // el tope silencioso
                        const data = rows.slice(start, end)
                            .map(r => Object.fromEntries(q.cols.map(c => [c, r[c]])));
                        resolve({ data, error: null, count: q.count ? rows.length : null });
                    } catch (err) {
                        reject(err);
                    }
                },
            };
            return builder;
        },
    };
    return { client, requests };
}

/**
 * `n2v2` partidas 2v2 válidas (4 jugadores), `n4v4` 4v4 válidas (8 jugadores)
 * y unas anuladas. El timestamp NO sigue el orden del id (una partida vieja
 * puede reportarse tarde), para probar que el orden final es por fecha.
 */
function makeTables({ n2v2 = 0, n4v4 = 0, nVoided = 0 } = {}) {
    const base = Date.parse('2026-07-01T00:00:00Z');
    const games = [];
    const players = [];
    let id = 0;
    let playerId = 0;
    const total = n2v2 + n4v4 + nVoided;
    const add = (format, isVoided, nPlayers) => {
        id++;
        const gid = `g-${String(id).padStart(5, '0')}`;
        // Permutación de minutos (7919 es primo y no divide a `total`): fechas únicas y desordenadas vs id.
        const minute = (id * 7919) % total;
        games.push({
            id, game_unique_id: gid, map_name: 'Guardian', game_type_name: 'TS',
            timestamp: new Date(base + minute * 60_000).toISOString(),
            duration: 300, is_teams_enabled: true, format, is_voided: isVoided,
        });
        for (let p = 0; p < nPlayers; p++) {
            playerId++;
            players.push({
                id: playerId, game_unique_id: gid, gamertag: `P${p}`, team_id: p % 2,
                score: 10, kills: 5, deaths: 5, assists: 1, most_kills_in_a_row: 2,
            });
        }
    };
    for (let i = 0; i < n2v2; i++) add('2v2', false, 4);
    for (let i = 0; i < n4v4; i++) add('4v4', false, 8);
    for (let i = 0; i < nVoided; i++) add('2v2', true, 4);
    return { games, players };
}

function makeService(tables, opts) {
    const svc = new SupabaseService();
    const fake = makeFakeClient(tables, opts);
    svc.client = fake.client;
    return { svc, requests: fake.requests };
}

function assertSortedDesc(games) {
    for (let i = 1; i < games.length; i++) {
        assert.ok(games[i - 1].timestamp >= games[i].timestamp, `orden por fecha roto en la posición ${i}`);
    }
}

test('getAllValidGamesWithPlayers trae TODAS las partidas aunque pasen de 1000 filas', async () => {
    const tables = makeTables({ n2v2: 2500, n4v4: 10, nVoided: 30 });
    const { svc } = makeService(tables);

    const games = await svc.getAllValidGamesWithPlayers('2v2');
    assert.strictEqual(games.length, 2500, 'antes se cortaba en silencio en 1000');
    assertSortedDesc(games);
    assert.ok(games.every(g => g.players.length === 4), 'cada partida 2v2 con sus 4 jugadores');
    assert.ok(games.every(g => !('id' in g)), 'el id interno no se filtra al resultado');
    assert.ok(games.every(g => g.format === '2v2'));
});

test('4v4: cada partida trae sus 8 jugadores (el lote de jugadores no se corta en 1000)', async () => {
    // Con el lote viejo de 200 partidas, 200 × 8 = 1600 filas > 1000: se perdían jugadores.
    const tables = makeTables({ n2v2: 5, n4v4: 300 });
    const { svc } = makeService(tables);

    const games = await svc.getAllValidGamesWithPlayers('4v4');
    assert.strictEqual(games.length, 300);
    assert.ok(games.every(g => g.players.length === 8));
});

test('sigue completo aunque el proyecto tuviera un max-rows menor que la página', async () => {
    const tables = makeTables({ n2v2: 1200 });
    const { svc } = makeService(tables, { maxRows: 300 });

    const games = await svc.getAllValidGamesWithPlayers('2v2');
    assert.strictEqual(games.length, 1200);
    assert.ok(games.every(g => g.players.length === 4));
});

test('getRecentGamesWithPlayers(10) sigue siendo UNA consulta de partidas con limit, por fecha', async () => {
    const tables = makeTables({ n2v2: 1500 });
    const { svc, requests } = makeService(tables);

    const games = await svc.getRecentGamesWithPlayers(10, '2v2');
    assert.strictEqual(games.length, 10);
    assertSortedDesc(games);
    const newest = [...tables.games].sort((a, b) => b.timestamp.localeCompare(a.timestamp))[0];
    assert.strictEqual(games[0].game_unique_id, newest.game_unique_id);

    const gameRequests = requests.filter(r => r.table === 'games');
    assert.strictEqual(gameRequests.length, 1);
    assert.strictEqual(gameRequests[0].limit, 10);
});

test('sin partidas del formato -> [] sin consultar jugadores', async () => {
    const tables = makeTables({ n2v2: 3 });
    const { svc, requests } = makeService(tables);

    assert.deepStrictEqual(await svc.getAllValidGamesWithPlayers('4v4'), []);
    assert.strictEqual(requests.filter(r => r.table === 'players').length, 0);
});
