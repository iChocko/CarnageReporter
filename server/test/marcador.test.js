/**
 * Tests del ajuste de marcador (!marcador): persistencia de ajustes.js, el
 * planificador puro (planAjuste), la construcción de partidas virtuales y su
 * integración con la tubería de rondas (sessions.js).
 *
 * Escenario que motiva todo: jugaron rondas antes de abrir el exe, o lo
 * echaron a andar a media serie — el marcador derivado quedó corto y el
 * admin declara el marcador REAL para que el bot inyecte lo que faltó.
 */

const { test } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ajustes = require('../utils/ajustes');
const { teamOutcomes } = require('../utils/records');
const { currentOrLastSession, computeEnfrentamientos, formatRondasMessage } = require('../utils/sessions');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wa-ajustes-'));

// Partida real sintética 2v2: [Alfa,Beta] vs [Cyto,Delta].
// Lado L = Alfa+Beta (con lineupOf queda como side 0: "Alfa·Beta" < "Cyto·Delta").
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

const SIDES = [['Alfa', 'Beta'], ['Cyto', 'Delta']];

/** Mezcla partidas reales con las virtuales de un plan, como getRondasGames. */
function merge(realGames, plan) {
    const firstTs = new Date(realGames[0].timestamp).getTime();
    const lastTs = new Date(realGames[realGames.length - 1].timestamp).getTime();
    const virtuals = ajustes.buildAjusteGames(plan, SIDES, firstTs, lastTs, { batchTs: 12345 });
    return [...realGames, ...virtuals].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
}

console.log('\n— ajustes.js (persistencia) —');

test('archivo faltante o corrupto -> lista vacía sin tronar', () => {
    const dir = tmpDir();
    assert.deepStrictEqual(ajustes.loadAjustes(dir).ajustes, []);
    fs.writeFileSync(path.join(dir, ajustes.AJUSTES_FILE), 'no-es-json{');
    assert.deepStrictEqual(ajustes.loadAjustes(dir).ajustes, []);
});

test('round-trip: save, load, y lotes inválidos se descartan', () => {
    const dir = tmpDir();
    const lote = {
        timestamp: new Date().toISOString(),
        declaredBy: 'test@c.us',
        sides: SIDES,
        games: ajustes.buildAjusteGames({ prepend: [1, 0], appends: [] }, SIDES, tsBase, tsBase, { batchTs: 1 }),
    };
    ajustes.saveAjustes(dir, { version: 1, ajustes: [lote, { basura: true }, { timestamp: 'manana', games: [] }] });
    const loaded = ajustes.loadAjustes(dir);
    assert.strictEqual(loaded.ajustes.length, 1);
    assert.strictEqual(ajustes.loadAjusteGames(dir).length, 2); // 1 ronda prefijo = 2 partidas
});

console.log('\n— planAjuste (planificador) —');

test('serie faltante desde cero: prefiere rondas de prefijo y respeta la ronda en curso', () => {
    // Reales: 1 victoria L. Realidad: L ya lleva la serie 2-0 y va 1-0 en la ronda.
    const plan = ajustes.planAjuste({ serie: [0, 0], cur: [1, 0] }, { serie: [2, 0], cur: null });
    assert.deepStrictEqual(plan.prepend, [2, 0]);
    assert.deepStrictEqual(plan.appends, []); // la ronda en curso 1-0 se queda intacta
});

test('cerrar la ronda en curso cuesta 1 partida, no un prefijo de 2', () => {
    // Derivado: serie 0-0, ronda 1-0. Real: esa ronda YA se cerró (serie 1-0, ronda 0-0).
    const plan = ajustes.planAjuste({ serie: [0, 0], cur: [1, 0] }, { serie: [1, 0], cur: [0, 0] });
    assert.deepStrictEqual(plan.prepend, [0, 0]);
    assert.deepStrictEqual(plan.appends, [0]); // una victoria más del lado 0 cierra la ronda
});

test('solo ronda en curso: agrega las victorias sueltas', () => {
    const plan = ajustes.planAjuste({ serie: [1, 1], cur: [0, 0] }, { serie: null, cur: [1, 1] });
    assert.deepStrictEqual(plan.prepend, [0, 0]);
    assert.deepStrictEqual(plan.appends.slice().sort(), [0, 1]);
});

test('serie para ambos lados a la vez', () => {
    const plan = ajustes.planAjuste({ serie: [0, 0], cur: [0, 0] }, { serie: [1, 1], cur: null });
    assert.deepStrictEqual(plan.prepend, [1, 1]);
});

test('errores: quitar rondas, ronda imposible, marcador idéntico', () => {
    assert.ok(ajustes.planAjuste({ serie: [2, 1], cur: [0, 0] }, { serie: [1, 1], cur: null }).error);
    assert.ok(ajustes.planAjuste({ serie: [0, 0], cur: [0, 0] }, { serie: null, cur: [2, 0] }).error);
    assert.ok(ajustes.planAjuste({ serie: [1, 0], cur: [1, 1] }, { serie: null, cur: [1, 0] }).error);
    assert.ok(ajustes.planAjuste({ serie: [1, 0], cur: [1, 0] }, { serie: [1, 0], cur: [1, 0] }).error);
});

console.log('\n— buildAjusteGames (partidas virtuales) —');

test('prefijo queda ANTES de la primera partida y después del reset; sufijo después de la última', () => {
    const firstTs = tsBase + 10 * 60 * 1000;
    const lastTs = tsBase + 30 * 60 * 1000;
    const resetTs = firstTs - 3 * 1000; // reset 3s antes de la primera partida: casi sin hueco
    const virtuals = ajustes.buildAjusteGames({ prepend: [1, 0], appends: [1] }, SIDES, firstTs, lastTs, { resetTs, batchTs: 7 });
    assert.strictEqual(virtuals.length, 3);
    const [p1, p2, ap] = virtuals.map(g => new Date(g.timestamp).getTime());
    assert.ok(p1 > resetTs && p2 > resetTs, 'el prefijo no debe caer antes del reset');
    assert.ok(p1 < firstTs && p2 < firstTs && p1 < p2, 'el prefijo va antes de la primera partida, en orden');
    assert.ok(ap > lastTs, 'el sufijo va después de la última partida');
});

test('el lado ganador y el marcador de la partida virtual son correctos', () => {
    const [g] = ajustes.buildAjusteGames({ prepend: [0, 1], appends: [] }, SIDES, tsBase, tsBase, { batchTs: 7 });
    const outcomes = teamOutcomes(g);
    assert.strictEqual(outcomes.get('Cyto'), 'W');
    assert.strictEqual(outcomes.get('Alfa'), 'L');
    assert.strictEqual(g.map_name, 'Ajuste');
    assert.ok(g.is_adjustment);
});

test('ids únicos dentro del lote', () => {
    const virtuals = ajustes.buildAjusteGames({ prepend: [2, 1], appends: [0, 1] }, SIDES, tsBase, tsBase, { batchTs: 7 });
    assert.strictEqual(new Set(virtuals.map(g => g.game_unique_id)).size, virtuals.length);
});

console.log('\n— integración con la tubería de rondas —');

test('escenario real: exe abierto a media serie -> el marcador queda como se declaró', () => {
    // Grabado: solo 1 victoria L (derivado: serie 0-0, ronda 1-0).
    // Realidad: L lleva 2 rondas ganadas y va 1-0 en la tercera.
    const real = [game('L', 0)];
    const derived = { serie: [0, 0], cur: [1, 0] };
    const plan = ajustes.planAjuste(derived, { serie: [2, 0], cur: null });
    const session = currentOrLastSession(merge(real, plan));
    assert.strictEqual(session.games.length, 5); // 4 de prefijo + 1 real
    const [e] = computeEnfrentamientos(session.games);
    assert.strictEqual(e.wonA, 2);
    assert.strictEqual(e.wonB, 0);
    assert.deepStrictEqual([e.current.winsA, e.current.winsB], [1, 0]);
    assert.ok(formatRondasMessage(session).includes('$50'), 'la cuenta cobra las 2 rondas');
});

test('declarar serie y ronda a la vez tras varias partidas reales', () => {
    // Grabado: L gana, R gana (derivado: serie 0-0, ronda 1-1).
    // Realidad: serie 1-1 y la ronda en curso va 0-0.
    const real = [game('L', 0), game('R', 10)];
    const plan = ajustes.planAjuste({ serie: [0, 0], cur: [1, 1] }, { serie: [1, 1], cur: [0, 0] });
    const session = currentOrLastSession(merge(real, plan));
    const [e] = computeEnfrentamientos(session.games);
    assert.strictEqual(e.wonA, 1);
    assert.strictEqual(e.wonB, 1);
    assert.strictEqual(e.current, null);
    assert.ok(formatRondasMessage(session).includes('empatada'));
});

test('los empates reales no estorban al plan (no suman a la ronda)', () => {
    const real = [game('T', 0), game('L', 5)]; // empate + victoria L => ronda 1-0
    const plan = ajustes.planAjuste({ serie: [0, 0], cur: [1, 0] }, { serie: [0, 1], cur: null });
    const session = currentOrLastSession(merge(real, plan));
    const [e] = computeEnfrentamientos(session.games);
    assert.strictEqual(e.wonA, 0);
    assert.strictEqual(e.wonB, 1);
    assert.deepStrictEqual([e.current.winsA, e.current.winsB], [1, 0]);
});

