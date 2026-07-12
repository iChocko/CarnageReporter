/**
 * Partidas dadas por perdida (comando !perdida, walkover / "W.O.").
 *
 * Cuando a alguien se le cierra el juego o se tiene que ir, su equipo puede
 * dar la partida por perdida: el equipo contrario gana y eso debe contar
 * para el marcador de rondas y la cuenta ($), pero NO para las stats
 * individuales (nadie jugó esa partida).
 *
 * Por eso un W.O. se persiste como archivo JSON en OUTPUT_DIR (mismo patrón
 * que rondasReset.js: volumen montado, sobrevive redeploys, nunca toca
 * Supabase) y se convierte en una "partida virtual" que se inyecta SOLO en
 * la tubería de rondas al momento de calcular. Todo lo demás (sesiones,
 * rondas primera-a-2, dinero, anuncio en vivo) funciona sin cambios.
 */

const fs = require('fs');
const path = require('path');

const FORFEITS_FILE = 'forfeits.json';

function forfeitsFilePath(dir) {
    return path.join(dir, FORFEITS_FILE);
}

function emptyForfeits() {
    return { version: 1, forfeits: [] };
}

/** Carga los W.O.; tolerante a archivo faltante o corrupto (lista vacía). */
function loadForfeits(dir) {
    try {
        const data = JSON.parse(fs.readFileSync(forfeitsFilePath(dir), 'utf-8'));
        if (!data || !Array.isArray(data.forfeits)) return emptyForfeits();
        const valid = data.forfeits.filter(f =>
            f && Number.isFinite(Date.parse(f.timestamp)) &&
            Array.isArray(f.sides) && f.sides.length === 2 &&
            f.sides.every(s => Array.isArray(s) && s.length > 0) &&
            (f.loserSide === 0 || f.loserSide === 1)
        );
        return { version: data.version || 1, forfeits: valid };
    } catch (e) {
        return emptyForfeits();
    }
}

/** Guarda los W.O. con escritura atómica (tmp + rename). */
function saveForfeits(dir, data) {
    const file = forfeitsFilePath(dir);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
}

/**
 * Convierte un W.O. en una partida virtual compatible con la tubería de
 * rondas (sessions.js decide el ganador sumando score por lado: 1-0).
 * `is_forfeit` la marca por si algún consumidor futuro quiere distinguirla.
 */
function forfeitToGame(f) {
    return {
        game_unique_id: `wo_${Date.parse(f.timestamp)}`,
        map_name: 'W.O.',
        timestamp: f.timestamp,
        is_forfeit: true,
        players: f.sides.flatMap((side, sideIdx) => side.map((gamertag, i) => ({
            gamertag,
            team_id: sideIdx,
            score: (sideIdx !== f.loserSide && i === 0) ? 1 : 0,
            kills: 0, deaths: 0, assists: 0,
        })))
    };
}

/** Todas las partidas virtuales W.O. del directorio, listas para mezclar. */
function loadForfeitGames(dir) {
    return loadForfeits(dir).forfeits.map(forfeitToGame);
}

/** Índice del lado (0|1) donde juega un gamertag, o -1 si no está. */
function sideIndexOf(sides, gamertag) {
    const key = String(gamertag || '').toLowerCase();
    return sides.findIndex(side => side.some(gt => String(gt).toLowerCase() === key));
}

/** Llave estable de una alineación (independiente del orden de lados/nombres). */
function lineupKeyOf(sides) {
    return sides
        .map(s => [...s].map(x => String(x).toLowerCase()).sort().join('·'))
        .sort()
        .join(' vs ');
}

module.exports = {
    loadForfeits, saveForfeits, forfeitToGame, loadForfeitGames, sideIndexOf,
    lineupKeyOf, FORFEITS_FILE
};
