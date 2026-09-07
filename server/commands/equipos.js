/**
 * Comando !caracola / !equipos (Fase A2 — movido tal cual desde index.js).
 */

'use strict';

const teams = require('../utils/teams');
const { buildEquiposReply, EQUIPOS_USAGE } = require('../domain/equipos');
const { resolveMentionsToTags, MAX_MENTION_TARGETS } = require('./mentions');

/**
 * Comando !caracola (alias !equipos) con soporte de menciones: los etiquetados
 * se traducen a gamertag vía el roster y la respuesta los menciona de vuelta;
 * lo escrito a mano sigue funcionando (invitados, sin mención).
 */
function createEquiposHandler(ctx) {
    return async function handleEquiposCommand({ format, args, mentionedIds }) {
        const hasMentions = (mentionedIds || []).length > 0;

        if (!hasMentions) {
            if (!(args || '').trim()) return EQUIPOS_USAGE;
            return buildEquiposReply(ctx, format, args);
        }

        // Techo ANTES de resolver: cada mención desconocida cuesta una ida al
        // puente LID↔teléfono; no dejar que un mensaje con 50 tags las pague.
        if (new Set(mentionedIds).size > MAX_MENTION_TARGETS) {
            return 'Máximo 16 jugadores.';
        }

        const { tags, unresolvedDisplays, botMentioned, jidByTagLower } = await resolveMentionsToTags(ctx, mentionedIds);

        if (botMentioned && tags.length === 0 && unresolvedDisplays.length === 0 && !teams.stripMentionTokens(args)) {
            return 'Yo no juego, yo reparto. Menciona a los 4 que van a entrar.';
        }

        if (unresolvedDisplays.length) {
            return [
                `Sin registrar: ${unresolvedDisplays.join(', ')}.`,
                'Que manden *!soy <gamertag>* o los vincula un admin con *!vincula @persona <gamertag>*.'
            ].join('\n');
        }

        const text = await buildEquiposReply(ctx, format, args, tags, {
            fromMentions: true,
            mentionJidByLower: jidByTagLower
        });

        // Adjuntar las menciones solo si el texto realmente lleva sus tokens
        // (los mensajes de error no los llevan).
        const mentions = [...jidByTagLower.values()].filter(jid => text.includes(`@${String(jid).split('@')[0]}`));
        return mentions.length ? { text, mentions } : text;
    };
}

module.exports = { createEquiposHandler };
