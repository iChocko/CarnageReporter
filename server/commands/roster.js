/**
 * Comando !roster (Fase A2 — movido tal cual desde index.js).
 */

'use strict';

const rosterStore = require('../utils/roster');
const { sanitizeCaptionText } = require('../utils/matchSummary');
const { jidDigits } = require('./mentions');
const { isAdminSender } = require('./admin');

/** Comando !roster: lista los vínculos; "unlink <tag>" (admin) desvincula. */
function createRosterHandler(ctx) {
    return async function handleRosterCommand({ args, msg, senderId }) {
        const arg = (args || '').trim();

        if (/^unlink(\s|$)/i.test(arg)) {
            if (!(await isAdminSender(ctx, senderId, msg))) return 'Solo un admin puede desvincular.';
            const tag = sanitizeCaptionText(arg.replace(/^unlink\s*/i, '')).trim();
            if (!tag) return 'Uso: !roster unlink <gamertag>';
            return ctx.locks.withRosterLock(async () => {
                const data = rosterStore.loadRoster(ctx.outputDir);
                if (!rosterStore.unlinkGamertag(data, tag)) return `*${tag}* no está en el roster.`;
                rosterStore.saveRoster(ctx.outputDir, data);
                return `*${tag}* fuera del roster.`;
            });
        }

        const data = rosterStore.loadRoster(ctx.outputDir);
        if (!data.links.length) return 'Roster vacío. Cada quien: !soy <gamertag>';

        const lines = [`*ROSTER* (${data.links.length} registrado${data.links.length !== 1 ? 's' : ''})`];
        for (const link of [...data.links].sort((a, b) => a.gamertag.localeCompare(b.gamertag))) {
            const phone = link.jids.find(j => j.endsWith('@c.us')) || link.jids[0] || '';
            const digits = jidDigits(phone) || '????';
            lines.push(`• ${link.gamertag} — …${digits}`);
        }
        lines.push('', 'Para registrarte: !soy <gamertag>');
        return lines.join('\n');
    };
}

module.exports = { createRosterHandler };
