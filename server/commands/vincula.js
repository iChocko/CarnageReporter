/**
 * Comando !vincula (Fase A2 — movido tal cual desde index.js).
 */

'use strict';

const teams = require('../utils/teams');
const rosterStore = require('../utils/roster');
const { sanitizeCaptionText } = require('../utils/matchSummary');
const { getKnownTagIndex, linkWithAliases, jidDigits, MAX_TAG_LEN } = require('./mentions');
const { isAdminSender } = require('./admin');

/** Comando !vincula @persona <gamertag>: registro hecho por un admin. */
function createVinculaHandler(ctx) {
    return async function handleVinculaCommand({ format, args, msg, mentionedIds, senderId }) {
        if (!(await isAdminSender(ctx, senderId, msg, format))) return 'Solo un admin puede hacer eso.';

        const own = ctx.whatsapp.getOwnIds();
        const targets = [...new Set(mentionedIds || [])].filter(j => !own.has(j));
        const tagInput = sanitizeCaptionText(teams.stripMentionTokens(args));
        if (targets.length !== 1 || !tagInput) return 'Uso: !vincula @persona <gamertag>';
        if (tagInput.length > MAX_TAG_LEN) return 'Ese gamertag no parece válido (muy largo).';
        if (tagInput.startsWith('!')) return 'Ese gamertag no parece válido.';

        const { knownByLower } = await getKnownTagIndex(ctx);
        const match = rosterStore.matchGamertag(tagInput, knownByLower);
        const canonical = sanitizeCaptionText(match.exact || tagInput);
        const known = Boolean(match.exact);

        return ctx.locks.withRosterLock(async () => {
            const data = rosterStore.loadRoster(ctx.outputDir);
            const result = await linkWithAliases(ctx, data, targets[0], canonical, { known, by: 'admin' });

            if (!result.ok && result.conflict) {
                return `*${canonical}* ya está registrado con otro número. Primero: !roster unlink ${canonical}`;
            }
            if (!result.ok) return 'Uso: !vincula @persona <gamertag>';

            const digits = jidDigits(targets[0]) || '????';
            const extra = known ? '' : ' (sin partidas todavía: rating provisional)';
            const sugerencia = (!known && match.suggestion) ? `\n¿O era *${sanitizeCaptionText(match.suggestion)}*?` : '';
            return `Listo: …${digits} es *${canonical}*${extra}.${sugerencia}`;
        });
    };
}

module.exports = { createVinculaHandler };
