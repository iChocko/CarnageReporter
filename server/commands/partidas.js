/**
 * Comando !partidas (Fase A2 — movido tal cual desde index.js).
 */

'use strict';

const { formatRecentGamesWhatsApp } = require('../utils/matchSummary');

/**
 * Comando del grupo: !partidas -> últimas 10 partidas del formato del grupo
 * (Retas H3 -> 2v2, Torneos Halo 3 -> 4v4).
 */
function createPartidasHandler(ctx) {
    return async function handlePartidasCommand({ format }) {
        const games = await ctx.gamesCache.getRecentGamesWithPlayers(10, format);
        return formatRecentGamesWhatsApp(games);
    };
}

module.exports = { createPartidasHandler };
