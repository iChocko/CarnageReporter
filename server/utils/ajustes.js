/**
 * Ajustes manuales del marcador (comando !marcador, solo admin).
 *
 * El marcador de !rondas se calcula al vuelo desde las partidas guardadas;
 * cuando se jugaron partidas con el exe cerrado, al cálculo le faltan piezas
 * y todo se desincroniza. Corregirlo = inyectar "partidas de ajuste"
 * virtuales que completen lo que faltó, igual que los W.O. de !perdida:
 * cuentan para el marcador de rondas y la cuenta ($), nunca para las stats
 * individuales (nadie las jugó frente al bot).
 *
 * El admin declara el marcador REAL (serie y/o ronda en curso) y planAjuste
 * calcula qué partidas virtuales agregarlas para que el marcador derivado
 * quede exactamente así. Solo se puede AGREGAR: si el bot tiene rondas o
 * victorias de más, eso se corrige con !anular / !perdida deshacer /
 * !rondas reset, no con este comando.
 *
 * Cada invocación se persiste como un "lote" en ajustes.json (OUTPUT_DIR,
 * volumen montado: sobrevive redeploys, nunca toca Supabase); deshacer
 * elimina el último lote completo.
 */

const fs = require('fs');
const path = require('path');

const AJUSTES_FILE = 'ajustes.json';

function ajustesFilePath(dir) {
    return path.join(dir, AJUSTES_FILE);
}

function emptyAjustes() {
    return { version: 1, ajustes: [] };
}

/** Carga los lotes de ajuste; tolerante a archivo faltante o corrupto. */
function loadAjustes(dir) {
    try {
        const data = JSON.parse(fs.readFileSync(ajustesFilePath(dir), 'utf-8'));
        if (!data || !Array.isArray(data.ajustes)) return emptyAjustes();
        const valid = data.ajustes.filter(a =>
            a && Number.isFinite(Date.parse(a.timestamp)) &&
            Array.isArray(a.games) && a.games.length > 0 &&
            a.games.every(g => g && Number.isFinite(Date.parse(g.timestamp)) && Array.isArray(g.players))
        );
        return { version: data.version || 1, ajustes: valid };
    } catch (e) {
        return emptyAjustes();
    }
}

/** Guarda los lotes con escritura atómica (tmp + rename). */
function saveAjustes(dir, data) {
    const file = ajustesFilePath(dir);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
}

/** Todas las partidas virtuales de ajuste, listas para mezclar en la tubería. */
function loadAjusteGames(dir) {
    return loadAjustes(dir).ajustes.flatMap(a => a.games);
}

/**
 * Planificador puro: qué partidas virtuales hacen falta para que el marcador
 * derivado quede igual al declarado. Lado 0 = equipo de la persona de
 * referencia del comando; lado 1 = el contrario.
 *
 * @param {{serie: number[], cur: number[]}} derived - lo que el bot calcula hoy
 * @param {{serie: number[]|null, cur: number[]|null}} target - lo declarado (null = no tocar)
 * @returns {{prepend: number[], appends: number[]} | {error: string}}
 *   prepend: rondas completas 2-0 por lado, ANTES del enfrentamiento
 *   appends: victorias sueltas al final, en orden (0|1 = lado que gana)
 */
function planAjuste(derived, target) {
    const tSerie = target.serie || derived.serie;
    const tCur = target.cur || derived.cur;

    if (tCur.some(v => v < 0 || v > 1) || tSerie.some(v => v < 0 || v > 30)) {
        return { error: 'La ronda en curso solo puede ir 0-0, 1-0, 0-1 o 1-1 (a 2 victorias se cierra). Si esa ronda ya se cerró, decláralo en la serie.' };
    }
    if (tSerie[0] < derived.serie[0] || tSerie[1] < derived.serie[1]) {
        return { error: `El bot ya tiene más rondas que eso (va ${derived.serie[0]}-${derived.serie[1]}). Este comando solo agrega lo que faltó; para quitar usa *!perdida deshacer*, *!anular*, *!marcador deshacer* o *!rondas reset*.` };
    }

    // Búsqueda exhaustiva (números diminutos): cuántas rondas completas van
    // como prefijo y qué victorias sueltas van al final. La ronda en curso
    // derivada puede ABSORBERSE en una ronda que se cierra al final, así que
    // el reparto prefijo/sufijo no es directo — se simula y se compara.
    const need = [tSerie[0] - derived.serie[0], tSerie[1] - derived.serie[1]];
    let best = null;

    for (let p0 = 0; p0 <= need[0]; p0++) {
        for (let p1 = 0; p1 <= need[1]; p1++) {
            for (const order of [[0, 1], [1, 0]]) {
                const sim = { serie: [derived.serie[0] + p0, derived.serie[1] + p1], cur: [...derived.cur] };
                const appends = [];
                const win = side => {
                    sim.cur[side]++;
                    appends.push(side);
                    if (sim.cur[side] === 2) { sim.serie[side]++; sim.cur = [0, 0]; }
                };

                for (const s of order) {
                    while (sim.serie[s] < tSerie[s]) win(s);
                }
                let ok = sim.cur[0] <= tCur[0] && sim.cur[1] <= tCur[1];
                if (ok) {
                    for (const s of [0, 1]) {
                        while (sim.cur[s] < tCur[s]) win(s); // tCur ≤ 1: nunca cierra
                    }
                }

                if (ok && sim.serie[0] === tSerie[0] && sim.serie[1] === tSerie[1]
                    && sim.cur[0] === tCur[0] && sim.cur[1] === tCur[1]) {
                    const totalGames = (p0 + p1) * 2 + appends.length;
                    const pre = p0 + p1;
                    // Menos partidas virtuales gana; a igualdad, más prefijo
                    // (lo que faltó normalmente pasó ANTES de abrir el exe).
                    if (!best || totalGames < best.totalGames || (totalGames === best.totalGames && pre > best.pre)) {
                        best = { prepend: [p0, p1], appends, totalGames, pre };
                    }
                }
            }
        }
    }

    if (!best) {
        return { error: `No se puede llegar a ese marcador solo agregando partidas (la ronda en curso va ${derived.cur[0]}-${derived.cur[1]} y no se pueden quitar victorias). Revisa lo declarado, o usa *!perdida deshacer* / *!anular* / *!rondas reset*.` };
    }
    if (best.totalGames === 0) return { error: 'El marcador ya está exactamente así; no hay nada que corregir.' };
    return { prepend: best.prepend, appends: best.appends };
}

/**
 * Convierte un plan en partidas virtuales con timestamps seguros:
 * - prefijo: segundos antes de la primera partida del enfrentamiento (pero
 *   después del último !rondas reset), para no mover sesiones ni el corte;
 * - sufijo: segundos después de la última, aunque el comando llegue horas
 *   más tarde — así la sesión no se estira ni se parte.
 * @param {{prepend: number[], appends: number[]}} plan - de planAjuste (lado 0 = refSide 0)
 * @param {string[][]} sides - alineación real [[A,B],[C,D]], lado 0 = referencia
 * @param {number} firstTs/lastTs - ms epoch de la primera/última partida del enfrentamiento
 * @param {{resetTs?: number|null, batchTs?: number}} opts
 * @returns {array} partidas virtuales listas para mezclar
 */
function buildAjusteGames(plan, sides, firstTs, lastTs, { resetTs = null, batchTs = Date.now() } = {}) {
    const games = [];
    let idx = 0;
    const mk = (winnerSide, ts) => ({
        game_unique_id: `aj_${batchTs}_${idx++}`,
        map_name: 'Ajuste',
        timestamp: new Date(ts).toISOString(),
        is_adjustment: true,
        players: sides.flatMap((side, sideIdx) => side.map((gamertag, i) => ({
            gamertag,
            team_id: sideIdx,
            score: (sideIdx === winnerSide && i === 0) ? 1 : 0,
            kills: 0, deaths: 0, assists: 0,
        })))
    });

    const preWins = [];
    for (const side of [0, 1]) for (let k = 0; k < plan.prepend[side]; k++) preWins.push(side, side);
    if (preWins.length) {
        let start = firstTs - (preWins.length + 1) * 1000;
        if (resetTs != null && start <= resetTs) start = resetTs + 1;
        const step = Math.max(1, Math.floor((firstTs - start) / (preWins.length + 1)));
        preWins.forEach((side, i) => games.push(mk(side, start + step * (i + 1))));
    }
    plan.appends.forEach((side, i) => games.push(mk(side, lastTs + (i + 1) * 1000)));
    return games;
}

module.exports = {
    loadAjustes, saveAjustes, loadAjusteGames, planAjuste, buildAjusteGames,
    AJUSTES_FILE
};
