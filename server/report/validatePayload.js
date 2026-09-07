/**
 * Validación del payload de /api/report (Fase A2 — movido tal cual desde
 * index.js). Rechaza formas inesperadas antes de tocar la BD o el renderer.
 */

'use strict';

function validateReportPayload(gameData, players) {
    if (typeof gameData !== 'object' || gameData === null) return 'gameData inválido';
    if (!Array.isArray(players)) return 'players debe ser un arreglo';
    if (players.length < 1 || players.length > 8) return 'cantidad de jugadores fuera de rango';
    if (typeof gameData.gameUniqueId !== 'string' || gameData.gameUniqueId.length < 1 || gameData.gameUniqueId.length > 255) {
        return 'gameUniqueId inválido';
    }
    for (const p of players) {
        if (typeof p !== 'object' || p === null) return 'jugador inválido';
        if (typeof p.gamertag !== 'string' || p.gamertag.length > 64) return 'gamertag inválido';
        for (const f of ['kills', 'deaths', 'assists', 'score']) {
            if (p[f] !== undefined && !Number.isFinite(Number(p[f]))) return `campo ${f} inválido`;
        }
    }
    return null;
}

module.exports = { validateReportPayload };
