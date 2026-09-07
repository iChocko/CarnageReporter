/**
 * Comando !marcador (Fase A2 — movido tal cual desde index.js).
 *
 * Solo admin: corrige el marcador cuando el bot se perdió partidas (el exe
 * estaba cerrado). El admin declara el marcador REAL — serie y/o ronda en
 * curso, orientado al equipo de la persona indicada — y se inyectan partidas
 * de ajuste virtuales (utils/ajustes.js) para que el cálculo derivado quede
 * exactamente así: cuentan para el marcador y la cuenta ($), nunca para las
 * stats. Deshacer elimina el último lote completo.
 */

'use strict';

const teams = require('../utils/teams');
const forfeits = require('../utils/forfeits');
const ajustes = require('../utils/ajustes');
const { sanitizeCaptionText } = require('../utils/matchSummary');
const { currentOrLastSession, formatLiveRoundUpdate, computeEnfrentamientos, RONDA_MXN } = require('../utils/sessions');
const { getResetTs } = require('../utils/rondasReset');
const { getRondasGames } = require('../domain/rondas');
const { resolveMentionsToTags } = require('./mentions');
const { isAdminSender } = require('./admin');
const { logger } = require('../logger');

const wappLog = logger.child({ mod: 'whatsapp' }); // comandos de WhatsApp manejados aquí (!anular, !marcador)

const MARCADOR_USAGE = 'Uso (solo admin): corrige el marcador si el bot se perdió partidas.\n' +
    '• *!marcador @persona 2-1* — la serie de su equipo queda 2-1\n' +
    '• *!marcador @persona 2-1 ronda 1-0* — serie 2-1 y ronda en curso 1-0\n' +
    '• *!marcador @persona ronda 1-0* — solo la ronda en curso\n' +
    '• *!marcador deshacer* — revierte el último ajuste\n' +
    'También con gamertag escrito: !marcador Fulano 2-1';

/**
 * Parsea "Fulano 2-1 ronda 1-0" -> { name, serie, cur }. Los pares "a-b" sin
 * palabra clave se asignan en orden: primero serie, luego ronda; "serie" y
 * "ronda" fuerzan el destino del par que sigue. Lo demás es el nombre.
 */
function parseMarcadorArgs(text) {
    const tokens = (text || '').split(/\s+/).filter(Boolean);
    let serie = null, cur = null, expect = null;
    const nameParts = [];
    for (const tk of tokens) {
        const m = tk.match(/^(\d{1,2})[-:](\d{1,2})$/);
        if (m) {
            const pair = [parseInt(m[1], 10), parseInt(m[2], 10)];
            const slot = expect || (!serie ? 'serie' : 'ronda');
            if (slot === 'serie' && !serie) serie = pair;
            else if (slot === 'ronda' && !cur) cur = pair;
            else return { error: MARCADOR_USAGE };
            expect = null;
        } else if (/^ronda$/i.test(tk)) expect = 'ronda';
        else if (/^serie$/i.test(tk)) expect = 'serie';
        else nameParts.push(tk);
    }
    return { name: nameParts.join(' '), serie, cur };
}

function createMarcadorHandler(ctx) {
    return async function handleMarcadorCommand({ format, args, msg, mentionedIds, senderId }) {
        if (format !== '2v2') {
            return 'El comando !marcador solo funciona en el grupo de retas 2v2.';
        }

        const parsed = parseMarcadorArgs(teams.stripMentionTokens(args));
        if (parsed.error) return parsed.error;

        if (parsed.name.trim().toLowerCase() === 'deshacer' && !parsed.serie && !parsed.cur) {
            if (!(await isAdminSender(ctx, senderId, msg))) return 'Solo un admin puede ajustar el marcador.';
            return ctx.locks.withAjusteLock(async () => {
                const data = ajustes.loadAjustes(ctx.outputDir);
                if (!data.ajustes.length) return 'No hay ajustes de marcador que revertir.';
                const removed = data.ajustes.pop();
                ajustes.saveAjustes(ctx.outputDir, data);
                ctx.gamesCache.invalidateAll();
                const n = removed.games.length;
                const update = formatLiveRoundUpdate(currentOrLastSession(await getRondasGames(ctx)));
                return [`Ajuste revertido (${n} partida${n !== 1 ? 's' : ''} virtual${n !== 1 ? 'es' : ''} fuera).`, update].filter(Boolean).join('\n');
            });
        }

        if (!parsed.serie && !parsed.cur) return MARCADOR_USAGE;
        if (!(await isAdminSender(ctx, senderId, msg))) return 'Solo un admin puede ajustar el marcador.';

        // ¿De quién es el equipo del primer número? Mención o gamertag escrito.
        const humanMentions = [...new Set(mentionedIds || [])].filter(j => !ctx.whatsapp.getOwnIds().has(j));
        if (humanMentions.length > 1) return 'Menciona solo a una persona de la reta.';
        let refTag = null;
        if (humanMentions.length === 1) {
            const { tags, unresolvedDisplays } = await resolveMentionsToTags(ctx, humanMentions);
            if (unresolvedDisplays.length) {
                return `Sin registrar: ${unresolvedDisplays.join(', ')}. Que mande *!soy <gamertag>* primero.`;
            }
            refTag = tags[0];
        }

        return ctx.locks.withAjusteLock(async () => {
            const games = await getRondasGames(ctx);
            const session = currentOrLastSession(games);
            if (!session || !session.games.length) {
                return 'No hay retas en la sesión. El ajuste se ancla a una reta con al menos una partida registrada (vale un W.O. de !perdida); registra una y vuelve a intentar.';
            }

            const enfs = computeEnfrentamientos(session.games);
            const clean = s => sanitizeCaptionText(s);
            const sideName = side => [...side].sort((a, b) => a.localeCompare(b)).map(clean).join(' + ');

            if (!refTag) {
                const typed = parsed.name.trim().toLowerCase();
                if (!typed) return MARCADOR_USAGE;
                const allTags = [...new Set(enfs.flatMap(e => e.sides.flat()))];
                const exact = allTags.filter(t => t.toLowerCase() === typed);
                const fuzzy = exact.length ? exact : allTags.filter(t => t.toLowerCase().includes(typed));
                if (fuzzy.length !== 1) {
                    return `No ubico a "${clean(parsed.name)}" en las retas de la sesión. Menciónalo con @ o escribe el gamertag como aparece en !rondas.`;
                }
                refTag = fuzzy[0];
            }

            // La reta más reciente de la sesión donde juega la persona de referencia
            const enf = [...enfs].reverse().find(e => forfeits.sideIndexOf(e.sides, refTag) !== -1);
            if (!enf) {
                return `*${clean(refTag)}* no está en ninguna reta de la sesión. El ajuste se ancla a una reta con al menos una partida registrada (vale un W.O. de !perdida).`;
            }
            const refSide = forfeits.sideIndexOf(enf.sides, refTag);
            const orient = (a, b) => refSide === 0 ? [a, b] : [b, a];

            const derived = {
                serie: orient(enf.wonA, enf.wonB),
                cur: enf.current ? orient(enf.current.winsA, enf.current.winsB) : [0, 0],
            };
            const plan = ajustes.planAjuste(derived, { serie: parsed.serie, cur: parsed.cur });
            if (plan.error) return plan.error;

            const enfGames = [...enf.rondas.flatMap(r => r.games), ...(enf.current ? enf.current.games : [])];
            const firstTs = new Date(enfGames[0].timestamp).getTime();
            const lastTs = new Date(enfGames[enfGames.length - 1].timestamp).getTime();
            const sidesOriented = refSide === 0 ? enf.sides : [enf.sides[1], enf.sides[0]];
            const virtuals = ajustes.buildAjusteGames(plan, sidesOriented, firstTs, lastTs, { resetTs: getResetTs(ctx.outputDir) });

            const data = ajustes.loadAjustes(ctx.outputDir);
            data.ajustes.push({
                timestamp: new Date().toISOString(),
                declaredBy: senderId || null,
                sides: sidesOriented,
                declared: { serie: parsed.serie, cur: parsed.cur },
                games: virtuals,
            });
            ajustes.saveAjustes(ctx.outputDir, data);
            ctx.gamesCache.invalidateAll();
            wappLog.info(`🛠️  [WHATSAPP] Marcador ajustado con !marcador: ${virtuals.length} partidas virtuales (por ${senderId || '?'})`);

            // Confirmar con el marcador YA corregido, recalculado de verdad
            const after = computeEnfrentamientos(currentOrLastSession(await getRondasGames(ctx)).games)
                .find(e => e.key === enf.key);
            if (!after) return `Listo: ${virtuals.length} partida(s) de ajuste agregadas. Checa *!rondas*.`;
            const [sL, sR] = orient(after.wonA, after.wonB);
            const [cL, cR] = after.current ? orient(after.current.winsA, after.current.winsB) : [0, 0];
            const nameL = sideName(sidesOriented[0]);
            const nameR = sideName(sidesOriented[1]);
            const lines = [
                `*Marcador corregido* (${virtuals.length} partida${virtuals.length !== 1 ? 's' : ''} de ajuste; no cuentan para stats).`,
                `Serie: *${nameL}* ${sL}-${sR} *${nameR}*${sL === sR ? ' — empatada' : ''}`,
            ];
            if (sL !== sR) lines.push(`💰 *${sL > sR ? nameR : nameL}* deben $${Math.abs(sL - sR) * RONDA_MXN}`);
            lines.push(`Ronda en curso: ${cL}-${cR}`);
            return lines.join('\n');
        });
    };
}

module.exports = { createMarcadorHandler, parseMarcadorArgs, MARCADOR_USAGE };
