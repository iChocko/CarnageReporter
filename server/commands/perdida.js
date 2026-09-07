/**
 * Comando !perdida (Fase A2 — movido tal cual desde index.js).
 *
 * Da por perdida la partida en curso (walkover / W.O.). El equipo del
 * declarante (o del mencionado) pierde; se registra una partida virtual que
 * cuenta para el marcador de rondas y la cuenta ($), nunca para las stats
 * individuales. Cualquiera de los 4 de la reta en curso puede declararla;
 * deshacer es solo de admin.
 */

'use strict';

const teams = require('../utils/teams');
const forfeits = require('../utils/forfeits');
const { sanitizeCaptionText } = require('../utils/matchSummary');
const { currentOrLastSession, formatLiveRoundUpdate, lineupOf } = require('../utils/sessions');
const { getRondasGames } = require('../domain/rondas');
const { resolveMentionsToTags, resolveSenderTag } = require('./mentions');
const { isAdminSender } = require('./admin');

const PERDIDA_USAGE = 'Usos:\n• *!perdida* — tu equipo da por perdida la partida en curso\n• *!perdida @persona* — el equipo de esa persona la da por perdida\n• *!perdida deshacer* — borra el último W.O. (solo admin)';

const FORFEIT_COOLDOWN_MS = 5 * 60 * 1000; // dos W.O. de la misma reta en <5 min = doble declaración

function createPerdidaHandler(ctx) {
    return async function handlePerdidaCommand({ format, args, msg, mentionedIds, senderId }) {
        if (format !== '2v2') {
            return 'El comando !perdida solo funciona en el grupo de retas 2v2.';
        }

        const own = ctx.whatsapp.getOwnIds();
        const allMentions = [...new Set(mentionedIds || [])];
        const humanMentions = allMentions.filter(j => !own.has(j));
        const arg = teams.stripMentionTokens(args).toLowerCase();

        if (arg === 'deshacer') {
            if (!(await isAdminSender(ctx, senderId, msg, format))) return 'Solo un admin puede deshacer un W.O.';
            return ctx.locks.withForfeitLock(async () => {
                const data = forfeits.loadForfeits(ctx.outputDir);
                if (!data.forfeits.length) return 'No hay W.O. que borrar.';
                const removed = data.forfeits.pop();
                forfeits.saveForfeits(ctx.outputDir, data);
                ctx.gamesCache.invalidateAll();
                const who = [...removed.sides[removed.loserSide]].sort().map(sanitizeCaptionText).join(' + ');
                const update = formatLiveRoundUpdate(currentOrLastSession(await getRondasGames(ctx)));
                return [`W.O. de ${who} borrado.`, update].filter(Boolean).join('\n');
            });
        }
        if (humanMentions.length > 1) return 'Menciona solo a una persona: !perdida @persona';
        // Mencionar solo al bot, o texto que no es "deshacer": mostrar el uso
        if (!humanMentions.length && (arg || allMentions.length)) return PERDIDA_USAGE;

        // ¿Quién la da por perdida? El mencionado, o el que manda el comando.
        // En ambos casos el DECLARANTE debe ser de la reta en curso (o admin).
        const senderTag = await resolveSenderTag(ctx, senderId);
        let target;
        if (humanMentions.length === 1) {
            const { tags, unresolvedDisplays } = await resolveMentionsToTags(ctx, humanMentions);
            if (unresolvedDisplays.length) {
                return `Sin registrar: ${unresolvedDisplays.join(', ')}. Que mande *!soy <gamertag>* primero.`;
            }
            target = tags[0];
        } else {
            target = senderTag;
            if (!target) return 'No sé quién eres. Manda *!soy <gamertag>* o usa: !perdida @persona';
        }

        // Validar y registrar DENTRO del candado: un "deshacer" u otro W.O.
        // concurrente puede cambiar la sesión entre la validación y la escritura.
        return ctx.locks.withForfeitLock(async () => {
            const games = await getRondasGames(ctx);
            const session = currentOrLastSession(games);
            if (!session || !session.live || !session.games.length) {
                return 'No hay reta en curso que dar por perdida.';
            }
            const { sides } = lineupOf(session.games[session.games.length - 1]);
            if (sides.length !== 2) return 'No hay reta en curso que dar por perdida.';

            const sideName = side => [...side].sort((a, b) => a.localeCompare(b)).map(sanitizeCaptionText).join(' + ');

            const senderInReta = senderTag && forfeits.sideIndexOf(sides, senderTag) !== -1;
            if (!senderInReta && !(await isAdminSender(ctx, senderId, msg, format))) {
                return `Solo los 4 de la reta en curso pueden declarar un W.O. (${sideName(sides[0])} 🆚 ${sideName(sides[1])}).`;
            }

            const loserSide = forfeits.sideIndexOf(sides, target);
            if (loserSide === -1) {
                return `*${sanitizeCaptionText(target)}* no está en la reta en curso (${sideName(sides[0])} 🆚 ${sideName(sides[1])}).`;
            }

            // Anti doble-declaración: si ya hay un W.O. de esta misma reta hace
            // menos de 5 min (dos personas reaccionando al mismo crash), no se apila.
            const data = forfeits.loadForfeits(ctx.outputDir);
            const last = data.forfeits[data.forfeits.length - 1];
            if (last && Date.now() - Date.parse(last.timestamp) < FORFEIT_COOLDOWN_MS
                && forfeits.lineupKeyOf(last.sides) === forfeits.lineupKeyOf(sides)) {
                return 'Ese W.O. ya quedó registrado hace un momento. Si perdieron OTRA partida más, repite el comando en unos minutos.';
            }

            data.forfeits.push({
                timestamp: new Date().toISOString(),
                sides,
                loserSide,
                declaredBy: senderId || null,
            });
            forfeits.saveForfeits(ctx.outputDir, data);
            ctx.gamesCache.invalidateAll();
            const update = formatLiveRoundUpdate(currentOrLastSession(await getRondasGames(ctx)));
            return [`W.O. de ${sideName(sides[loserSide])}.`, update].filter(Boolean).join('\n');
        });
    };
}

module.exports = { createPerdidaHandler, PERDIDA_USAGE, FORFEIT_COOLDOWN_MS };
