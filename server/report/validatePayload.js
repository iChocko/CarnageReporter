/**
 * Validación del payload de /api/report (Fase A2 — movido tal cual desde
 * index.js). Rechaza formas inesperadas antes de tocar la BD o el renderer.
 */

'use strict';

/**
 * @param {object} gameData
 * @param {object[]} players
 * @param {{ installId?: any, clientSentAt?: any }} [extra] Campos de
 *   identidad/hora del cliente (Fase B3, solo presentes en schemaVersion 3):
 *   si vienen, deben ser strings cortos; si no vienen, no se rechazan (los
 *   clientes v1/v2 siguen funcionando exactamente igual).
 */
function validateReportPayload(gameData, players, extra = {}) {
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

    const { installId, clientSentAt } = extra;
    if (installId !== undefined && installId !== null) {
        if (typeof installId !== 'string' || installId.length > 64) return 'installId inválido';
    }
    if (clientSentAt !== undefined && clientSentAt !== null) {
        if (typeof clientSentAt !== 'string' || clientSentAt.length > 64) return 'clientSentAt inválido';
    }

    return null;
}

module.exports = { validateReportPayload };
