/**
 * Clasificación de formato de partida por su estructura de equipos.
 * Soportados: 2v2 (2 equipos de 2) y 4v4 (2 equipos de 4).
 */

/**
 * @param {array} players - [{ teamId | team_id, ... }]
 * @returns {'2v2'|'4v4'|null}
 */
function classifyFormat(players) {
    if (!Array.isArray(players) || players.length === 0) return null;

    const teamCounts = new Map();
    for (const p of players) {
        const tid = p.teamId ?? p.team_id ?? 0;
        teamCounts.set(tid, (teamCounts.get(tid) || 0) + 1);
    }

    if (teamCounts.size !== 2) return null;
    const sizes = [...teamCounts.values()];
    if (sizes.every(n => n === 2)) return '2v2';
    if (sizes.every(n => n === 4)) return '4v4';
    return null;
}

const FORMATS = ['2v2', '4v4'];

module.exports = { classifyFormat, FORMATS };
