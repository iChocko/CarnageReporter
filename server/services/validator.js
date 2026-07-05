/**
 * Match Validator
 * Decide si una partida debe anularse (reiniciada, abandonada o no concluida).
 *
 * Las partidas anuladas SE GUARDAN en la base de datos con is_voided=true
 * (no cuentan para stats ni se publican), y pueden restaurarse con el
 * endpoint admin de unvoid si la detección fue un falso positivo.
 */

const VOID_MIN_DURATION_SECONDS = parseInt(process.env.VOID_MIN_DURATION_SECONDS || '150', 10);

// El bot registra EXCLUSIVAMENTE partidas 2v2 (2 equipos de 2 jugadores).
// Escape hatch: REQUIRE_2V2=false en el .env si algún día se quiere abrir.
const REQUIRE_2V2 = process.env.REQUIRE_2V2 !== 'false';

/**
 * ¿Es una partida 2v2? Equipos habilitados, exactamente 2 equipos, 2 jugadores cada uno.
 */
function is2v2(gameData, players) {
    if (gameData.isTeamsEnabled === false) return false;

    const teamCounts = new Map();
    for (const p of players) {
        const tid = p.teamId ?? 0;
        teamCounts.set(tid, (teamCounts.get(tid) || 0) + 1);
    }

    if (teamCounts.size !== 2) return false;
    return [...teamCounts.values()].every(count => count === 2);
}

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
    // Regla 0: solo partidas 2v2 (estructural, aplica a cualquier versión de payload)
    if (REQUIRE_2V2 && !is2v2(gameData, players)) {
        return { voided: true, reason: 'not_2v2' };
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

module.exports = { evaluateMatch, is2v2, VOID_MIN_DURATION_SECONDS, REQUIRE_2V2 };
