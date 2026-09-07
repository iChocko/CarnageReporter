/**
 * Comando !soy (Fase A2 — movido tal cual desde index.js).
 */

'use strict';

const rosterStore = require('../utils/roster');
const { sanitizeCaptionText } = require('../utils/matchSummary');
const { getKnownTagIndex, linkWithAliases, resolveSenderTag, MAX_TAG_LEN } = require('./mentions');

/** Comando !soy <gamertag>: autoregistro número ↔ gamertag. */
function createSoyHandler(ctx) {
    return async function handleSoyCommand({ args, senderId }) {
        const input = sanitizeCaptionText(args || '').trim();

        if (!input) {
            const tag = await resolveSenderTag(ctx, senderId);
            if (tag) return `Estás registrado como *${tag}*. Para cambiar: !soy <gamertag>`;
            return 'No estás registrado. Uso: !soy <tu gamertag>';
        }

        let force = false;
        let tagInput = input;
        if (/\sconfirmar$/i.test(tagInput)) {
            force = true;
            tagInput = tagInput.replace(/\sconfirmar$/i, '').trim();
        }
        if (!tagInput) return 'No estás registrado. Uso: !soy <tu gamertag>';
        if (tagInput.length > MAX_TAG_LEN) return 'Ese gamertag no parece válido (muy largo).';
        // Un tag que empieza con "!" podría disparar comandos al ser eco en respuestas
        if (tagInput.startsWith('!')) return 'Ese gamertag no parece válido.';

        const { knownByLower, gamesByLower } = await getKnownTagIndex(ctx);
        const match = rosterStore.matchGamertag(tagInput, knownByLower);

        if (match.suggestion && !force) {
            const sugerencia = sanitizeCaptionText(match.suggestion);
            return `No encuentro *${tagInput}*. ¿Quisiste decir *${sugerencia}*? Manda: !soy ${sugerencia}\nSi de verdad es un tag nuevo: !soy ${tagInput} confirmar`;
        }

        const canonical = sanitizeCaptionText(match.exact || tagInput);
        const known = Boolean(match.exact);

        return ctx.locks.withRosterLock(async () => {
            const data = rosterStore.loadRoster(ctx.outputDir);
            const result = await linkWithAliases(ctx, data, senderId, canonical, { known, by: 'self' });

            if (!result.ok && result.conflict) {
                return `*${canonical}* ya está registrado con otro número. Si es un error, que un admin corra: !roster unlink ${canonical}`;
            }
            if (!result.ok) return 'No pude registrarte. Uso: !soy <tu gamertag>';

            if (result.previous) {
                return `Actualizado: ahora eres *${canonical}* (antes ${sanitizeCaptionText(result.previous)}).`;
            }
            if (known) {
                const n = gamesByLower.get(canonical.toLowerCase()) || 0;
                return `Listo: eres *${canonical}* (${n} partida${n !== 1 ? 's' : ''}). Ya te pueden mencionar en !caracola.`;
            }
            return `Registrado: *${canonical}*. Cero partidas todavía: tu rating será provisional hasta que juegues.`;
        });
    };
}

module.exports = { createSoyHandler };
