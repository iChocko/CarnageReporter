/**
 * Comando !caracola (alias !equipos) (Fase A2 — movido tal cual desde
 * index.js, salvo que ahora recibe `ctx` y pasa por el cache de partidas).
 */

'use strict';

const teams = require('../utils/teams');
const { sanitizeCaptionText } = require('../utils/matchSummary');
const { computeDuoRecords } = require('../utils/records');

const OTHER_FORMAT = { '2v2': '4v4', '4v4': '2v2' };
const EQUIPOS_USAGE = 'Uso: !caracola @P1 @P2 @P3 @P4 — también acepto gamertags escritos o mezcla: !caracola @P1 @P2 Fulano, Invitado';

/**
 * Arma la respuesta del comando !equipos: divide la lista de jugadores en dos
 * equipos parejos según el skill del formato del grupo (con fallback al otro
 * formato y a la media). Función compartida por el comando de WhatsApp y el
 * endpoint admin de prueba.
 *
 * En 2v2 con exactamente 4 jugadores evalúa los 3 emparejamientos posibles
 * (con ajuste por duplas con historial) y responde el más parejo + alternativas.
 * @param {string[]} mentionTags - gamertags ya resueltos desde menciones
 * @param {boolean} fromMentions - aplica la regla de exactamente 4 (solo 2v2)
 */
async function buildEquiposReply(ctx, format, args, mentionTags = [], { fromMentions = false, mentionJidByLower = null } = {}) {
    const [primaryGames, secondaryGames] = await Promise.all([
        ctx.gamesCache.getAllValidGamesWithPlayers(format),
        ctx.gamesCache.getAllValidGamesWithPlayers(OTHER_FORMAT[format])
    ]);
    const primary = teams.computeSkillIndex(primaryGames);
    const secondary = teams.computeSkillIndex(secondaryGames);

    // Diccionario de gamertags conocidos (ambos formatos) para parsear la lista
    const knownByLower = new Map();
    for (const idx of [secondary, primary]) { // primary al final: tiene prioridad
        for (const [lower, v] of idx.byLower) knownByLower.set(lower, v.name);
    }

    const typedNames = teams.parsePlayerList(teams.stripMentionTokens(args), knownByLower);
    // Sanitizar TODO lo que se va a eco en la respuesta (texto del usuario y
    // tags canónicos que pudieran venir contaminados desde la BD)
    const names = [...mentionTags, ...typedNames].map(n => sanitizeCaptionText(n)).filter(Boolean);

    const exactRule = fromMentions && format === '2v2' ? { exact: 4 } : {};
    const validation = teams.validateRoster(names, exactRule);
    if (!validation.ok) return validation.error;

    const roster = teams.resolveRoster(validation.roster, primary, secondary);

    // 2v2 con 4 jugadores: los 3 emparejamientos posibles, del más parejo al menos
    if (format === '2v2' && roster.length === 4) {
        const duoRecords = computeDuoRecords(primaryGames);
        const ranked = teams.rankPairings(roster, duoRecords);
        return teams.formatPairingsMessage(roster, ranked, mentionJidByLower);
    }

    const result = teams.balanceTeams(roster);
    return teams.formatTeamsMessage(format, roster, result, mentionJidByLower);
}

module.exports = { buildEquiposReply, OTHER_FORMAT, EQUIPOS_USAGE };
