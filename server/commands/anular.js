/**
 * Comando !anular (Fase A2 — movido tal cual desde index.js).
 *
 * Anula POR COMPLETO la última partida registrada (se inició por error y aun
 * así el cliente la reportó). A diferencia de !perdida (que agrega un W.O. de
 * una reta legítima) y de !rondas reset (que solo corta el marcador visible),
 * esto marca la partida como is_voided en la base y deja de contar para TODO:
 * marcador, cuenta ($), corte semanal y stats. Pueden anular los que la
 * jugaron (o un admin); deshacer es solo de admin.
 */

'use strict';

const teams = require('../utils/teams');
const anuladas = require('../utils/anuladas');
const { sanitizeCaptionText } = require('../utils/matchSummary');
const { SESSION_GAP_MINUTES } = require('../utils/sessions');
const { logger } = require('../logger');
const { resolveSenderTag } = require('./mentions');
const { isAdminSender } = require('./admin');

const wappLog = logger.child({ mod: 'whatsapp' }); // comandos de WhatsApp manejados aquí (!anular, !marcador)

const ANULAR_USAGE = 'Usos:\n• *!anular* — anula la última partida registrada (se jugó por error): deja de contar para marcador, cuenta y stats\n• *!anular deshacer* — restaura la última partida anulada con este comando (solo admin)\nPara borrar un W.O. usa *!perdida deshacer*.';

function createAnularHandler(ctx) {
    return async function handleAnularCommand({ format, args, msg, mentionedIds, senderId }) {
        const arg = teams.stripMentionTokens(args).toLowerCase();

        if (arg === 'deshacer') {
            if (!(await isAdminSender(ctx, senderId, msg))) return 'Solo un admin puede deshacer una anulación.';
            return ctx.locks.withAnularLock(async () => {
                const data = anuladas.loadAnuladas(ctx.outputDir);
                if (!data.anuladas.length) return 'No hay partidas anuladas con este comando que restaurar.';
                const removed = data.anuladas.pop();
                await ctx.supabase.setVoided(removed.gameId, false);
                anuladas.saveAnuladas(ctx.outputDir, data);
                ctx.gamesCache.invalidateAll();
                return `Partida restaurada: *${sanitizeCaptionText(removed.mapName || '?')}* (${removed.gameId.slice(0, 8)}). Vuelve a contar para todo.`;
            });
        }
        if (arg || (mentionedIds || []).length) return ANULAR_USAGE;

        const [isAdmin, senderTag] = await Promise.all([
            isAdminSender(ctx, senderId, msg),
            resolveSenderTag(ctx, senderId),
        ]);

        // Validar y anular DENTRO del candado: dos !anular casi simultáneos no
        // deben tumbar dos partidas (la segunda sería una partida real).
        return ctx.locks.withAnularLock(async () => {
            const [game] = await ctx.gamesCache.getRecentGamesWithPlayers(1, format);
            const data = anuladas.loadAnuladas(ctx.outputDir);
            const last = data.anuladas[data.anuladas.length - 1];
            const check = anuladas.validateAnulacion({
                game, senderTag, isAdmin,
                lastAnnulledAt: last ? last.annulledAt : null,
                gapMinutes: SESSION_GAP_MINUTES,
            });
            if (!check.ok) return check.error;

            await ctx.supabase.setVoided(game.game_unique_id, true, `comando !anular por ${senderTag || senderId || 'desconocido'}`);
            data.anuladas.push({
                gameId: game.game_unique_id,
                mapName: game.map_name,
                gameTimestamp: game.timestamp,
                annulledAt: new Date().toISOString(),
                by: senderId || null,
            });
            anuladas.saveAnuladas(ctx.outputDir, data);
            ctx.gamesCache.invalidateAll();
            wappLog.info(`🚫 [WHATSAPP] Partida anulada con !anular: ${game.game_unique_id} (por ${senderTag || senderId || '?'})`);

            const quienes = [...new Set((game.players || []).map(p => sanitizeCaptionText(p.gamertag)))].join(', ');
            return `*Partida anulada:* ${sanitizeCaptionText(game.map_name || '?')} (${game.game_unique_id.slice(0, 8)})${quienes ? ` — ${quienes}` : ''}.\nYa no cuenta para marcador, cuenta ni stats.`;
        });
    };
}

module.exports = { createAnularHandler, ANULAR_USAGE };
