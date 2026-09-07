/**
 * Partidas que cuentan para el marcador de rondas y para el corte semanal
 * (Fase A2 — antes `getRondasGames`/`getSaldosGames` en index.js, duplicaban
 * el fetch+merge; aquí se unifican en `getGamesSince` con un cutoff).
 */

'use strict';

const forfeits = require('../utils/forfeits');
const ajustes = require('../utils/ajustes');
const { getResetTs } = require('../utils/rondasReset');
const { getLastCorteTs } = require('../utils/saldos');

/**
 * Todas las partidas válidas 2v2 + W.O. (forfeits) + ajustes de marcador,
 * mezcladas y ordenadas por fecha, filtradas a partir de `cutoffTs` (o sin
 * filtrar si es null/undefined/0).
 * @param {number|null} cutoffTs
 * @param {{ gamesCache: object, outputDir: string }} ctx
 */
async function getGamesSince(cutoffTs, { gamesCache, outputDir }) {
    const games = await gamesCache.getAllValidGamesWithPlayers('2v2');
    const merged = [...games, ...forfeits.loadForfeitGames(outputDir), ...ajustes.loadAjusteGames(outputDir)]
        .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    if (!cutoffTs) return merged;
    return merged.filter(g => new Date(g.timestamp).getTime() > cutoffTs);
}

/**
 * Partidas 2v2 que cuentan para el marcador de rondas: todas las válidas
 * más los W.O. (partidas dadas por perdida, virtuales — no tocan stats),
 * menos las anteriores al último "!rondas reset" (siguen en las stats).
 */
async function getRondasGames(ctx) {
    return getGamesSince(getResetTs(ctx.outputDir), ctx);
}

/**
 * Partidas que cuentan para el CORTE SEMANAL. A diferencia del marcador,
 * la ventana arranca en el último corte, NO en el último "!rondas reset":
 * el reset (abierto a todo el grupo) limpia el marcador visible, pero las
 * deudas de la semana persisten hasta que el corte del lunes las cobra.
 * Si nunca ha habido corte (estreno de la función) se cae al último reset.
 */
async function getSaldosGames(ctx) {
    const sinceTs = getLastCorteTs(ctx.outputDir) ?? getResetTs(ctx.outputDir);
    return getGamesSince(sinceTs, ctx);
}

module.exports = { getGamesSince, getRondasGames, getSaldosGames };
