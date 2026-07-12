/**
 * Marcador de reinicio de !rondas ("borrón y cuenta nueva").
 *
 * Las sesiones/rondas se calculan al vuelo desde las partidas guardadas, así
 * que "resetear" = guardar un instante de corte: las partidas anteriores dejan
 * de contar para el marcador y la cuenta (siguen existiendo para las stats).
 *
 * Se persiste como archivo JSON en el directorio de salida (OUTPUT_DIR), que
 * en producción es un volumen montado del host: sobrevive redeploys/reinicios
 * sin necesidad de tocar el esquema de la base de datos.
 */

const fs = require('fs');
const path = require('path');

const RESET_FILE = 'rondas_reset.json';

function resetFilePath(dir) {
    return path.join(dir, RESET_FILE);
}

/** Timestamp (ms epoch) del último reset, o null si no hay. */
function getResetTs(dir) {
    try {
        const data = JSON.parse(fs.readFileSync(resetFilePath(dir), 'utf-8'));
        return Number.isFinite(data.resetTs) ? data.resetTs : null;
    } catch (e) {
        return null;
    }
}

/** Registra un reset en este instante (o en el ts indicado). */
function setResetTs(dir, ts = Date.now()) {
    fs.writeFileSync(resetFilePath(dir), JSON.stringify({ resetTs: ts, resetAt: new Date(ts).toISOString() }));
    return ts;
}

/** Filtra las partidas que cuentan para el marcador (posteriores al reset). */
function filterGamesAfterReset(games, dir) {
    const resetTs = getResetTs(dir);
    if (!resetTs) return games;
    return games.filter(g => new Date(g.timestamp).getTime() > resetTs);
}

module.exports = { getResetTs, setResetTs, filterGamesAfterReset };
