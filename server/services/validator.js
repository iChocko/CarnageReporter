/**
 * Match Validator
 * Decide si una partida debe anularse (reiniciada, abandonada o no concluida).
 *
 * Las partidas anuladas SE GUARDAN en la base de datos con is_voided=true
 * (no cuentan para stats ni se publican), y pueden restaurarse con el
 * endpoint admin de unvoid si la detección fue un falso positivo.
 */

const { classifyFormat } = require('../utils/format');

const VOID_MIN_DURATION_SECONDS = parseInt(process.env.VOID_MIN_DURATION_SECONDS || '150', 10);

/**
 * Evalúa una partida entrante.
 *
 * Las reglas basadas en duración/completitud SOLO aplican a payloads v2+:
 * los clientes v1 (<= 1.2.0) no mandan esos campos (duration siempre 0),
 * y aplicarles esas reglas anularía todas sus partidas.
 *
 * @param {object} gameData - Datos del juego (payload del cliente)
 * @param {array} players - Jugadores de la partida
 * @param {number} schemaVersion - Versión del payload (1 = cliente legacy)
 * @returns {{voided: boolean, reason: string|null}}
 */
function evaluateMatch(gameData, players, schemaVersion) {
    // Regla 0: solo formatos soportados (2v2 o 4v4). Estructural, cualquier versión.
    if (classifyFormat(players) === null) {
        return { voided: true, reason: 'unsupported_format' };
    }

    // Regla 1: el propio juego marcó la partida como incompleta
    if (gameData.lastMatchIncomplete === true) {
        return { voided: true, reason: 'last_match_incomplete' };
    }

    if (schemaVersion >= 2) {
        // Regla 2: partida demasiado corta (típico de reinicios "alguien fue al baño")
        const duration = parseInt(gameData.duration || 0, 10);
        if (duration > 0 && duration < VOID_MIN_DURATION_SECONDS) {
            return { voided: true, reason: 'too_short' };
        }

        // Regla 3: la mayoría de los jugadores no terminó la partida
        const withFlag = players.filter(p => p.completedGame === 0 || p.completedGame === 1);
        if (withFlag.length > 0) {
            const quitters = withFlag.filter(p => p.completedGame === 0).length;
            if (quitters > withFlag.length / 2) {
                return { voided: true, reason: 'majority_quit' };
            }
        }
    }

    return { voided: false, reason: null };
}

module.exports = { evaluateMatch, VOID_MIN_DURATION_SECONDS };
