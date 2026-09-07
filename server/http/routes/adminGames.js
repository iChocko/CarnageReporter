/**
 * Endpoints admin sobre partidas: void/unvoid/delete, mapas sin identificar
 * (Fase A2 — movidos tal cual desde index.js) y republish (Fase A4).
 */

'use strict';

const path = require('path');
const express = require('express');
const { asyncHandler } = require('../errors');
const { adminAuthMiddleware } = require('../auth');
const { MAP_NAMES } = require('../../utils/maps');
const { FORMATS, classifyFormat } = require('../../utils/format');
const { buildCaptionParts } = require('../../utils/matchSummary');
const { publishRow } = require('../../messaging/outboxPublish');
const { logger } = require('../../logger');

const log = logger.child({ mod: 'http' });

/** DB row (snake_case, ver supabase_schema.sql) -> gameData (camelCase, forma del payload del cliente). */
function dbRowToGameData(game) {
    return {
        gameUniqueId: game.game_unique_id,
        gameEnum: game.game_enum,
        isMatchmaking: game.is_matchmaking,
        isTeamsEnabled: game.is_teams_enabled,
        hopperName: game.hopper_name,
        gameTypeName: game.game_type_name,
        mapName: game.map_name,
        mapCode: game.map_code,
        timestamp: game.timestamp,
        duration: game.duration,
        playlistName: game.playlist_name,
        lastMatchIncomplete: game.last_match_incomplete,
        partySize: game.party_size,
    };
}

/** DB row de `players` -> forma camelCase esperada por renderer/discord/captions. */
function dbRowToPlayer(p) {
    return {
        xboxUserId: p.xbox_user_id,
        gamertag: p.gamertag,
        clanTag: p.clan_tag,
        serviceId: p.service_id,
        teamId: p.team_id,
        score: p.score,
        standing: p.standing,
        kills: p.kills,
        deaths: p.deaths,
        assists: p.assists,
        betrayals: p.betrayals,
        suicides: p.suicides,
        mostKillsInARow: p.most_kills_in_a_row,
        secondsPlayed: p.seconds_played,
        secondsAlive: p.seconds_alive,
        completedGame: p.completed_game,
        killsWeapon: p.kills_weapon,
        killsGrenade: p.kills_grenade,
        killsMelee: p.kills_melee,
        killsOther: p.kills_other,
        isGuest: p.is_guest,
        medals: p.medals,
    };
}

/**
 * Resuelve un ID (corto o completo) a un único game_unique_id.
 * Responde el error adecuado y devuelve null si no se puede resolver.
 */
async function resolveGameId(ctx, idParam, res) {
    // Aceptar solo caracteres válidos de un UUID/ID (bloquea comodines de LIKE % _)
    const id = String(idParam || '').trim();
    if (!/^[a-zA-Z0-9-]{6,64}$/.test(id)) {
        res.status(400).json({ error: 'ID inválido (mínimo 6 caracteres alfanuméricos)' });
        return null;
    }

    const matches = await ctx.supabase.findGamesByIdPrefix(id);
    if (matches.length === 0) {
        res.status(404).json({ error: `No existe partida con ID '${id}'` });
        return null;
    }
    if (matches.length > 1) {
        res.status(409).json({
            error: `El prefijo '${id}' es ambiguo (${matches.length} coincidencias). Usa más caracteres.`,
            candidates: matches
        });
        return null;
    }
    return matches[0].game_unique_id;
}

function createAdminGamesRouter(ctx) {
    const router = express.Router();
    const adminAuth = adminAuthMiddleware(ctx.config);

    /**
     * Últimas N partidas (incluye anuladas, con motivo) para el panel admin
     * del dashboard: !partidas/stats.js solo muestran válidas, aquí se
     * necesita ver también lo anulado para poder restaurarlo.
     * GET /api/admin/games?limit=20&format=2v2|4v4
     */
    router.get('/api/admin/games', adminAuth, asyncHandler(async (req, res) => {
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
        const format = FORMATS.includes(req.query.format) ? req.query.format : null;

        let query = ctx.supabase.client
            .from('games')
            .select('game_unique_id, map_name, timestamp, format, is_voided, void_reason');
        if (format) query = query.eq('format', format);
        query = query.order('timestamp', { ascending: false }).limit(limit);

        const { data: games, error } = await query;
        if (error) throw error;
        if (!games || games.length === 0) return res.json([]);

        const ids = games.map(g => g.game_unique_id);
        const { data: players, error: pError } = await ctx.supabase.client
            .from('players')
            .select('game_unique_id, gamertag, team_id, score, kills, deaths')
            .in('game_unique_id', ids);
        if (pError) throw pError;

        const byGame = new Map();
        for (const p of players || []) {
            if (!byGame.has(p.game_unique_id)) byGame.set(p.game_unique_id, []);
            byGame.get(p.game_unique_id).push({
                gamertag: p.gamertag, team_id: p.team_id, score: p.score, kills: p.kills, deaths: p.deaths
            });
        }

        res.json(games.map(g => ({ ...g, players: byGame.get(g.game_unique_id) || [] })));
    }));

    /**
     * Eliminar una partida (y sus jugadores) por ID corto o completo.
     * DELETE /api/admin/games/:id
     * Header: X-Admin-Key
     */
    router.delete('/api/admin/games/:id', adminAuth, asyncHandler(async (req, res) => {
        const fullId = await resolveGameId(ctx, req.params.id, res);
        if (!fullId) return;

        await ctx.supabase.deleteGame(fullId);
        ctx.gamesCache.invalidateAll();
        log.info(`🗑️  [ADMIN] Partida eliminada: ${fullId}`);
        res.json({ status: 'deleted', gameId: fullId });
    }));

    /**
     * Restaurar una partida anulada (falso positivo del validador).
     * POST /api/admin/games/:id/unvoid
     */
    router.post('/api/admin/games/:id/unvoid', adminAuth, asyncHandler(async (req, res) => {
        const fullId = await resolveGameId(ctx, req.params.id, res);
        if (!fullId) return;

        await ctx.supabase.setVoided(fullId, false);
        ctx.gamesCache.invalidateAll();
        log.info(`♻️  [ADMIN] Partida restaurada: ${fullId}`);
        res.json({ status: 'unvoided', gameId: fullId });
    }));

    /**
     * Anular manualmente una partida (ej. detectada tarde como reiniciada).
     * POST /api/admin/games/:id/void
     * Body opcional: { reason: "texto" }
     */
    router.post('/api/admin/games/:id/void', adminAuth, asyncHandler(async (req, res) => {
        const fullId = await resolveGameId(ctx, req.params.id, res);
        if (!fullId) return;

        await ctx.supabase.setVoided(fullId, true, req.body?.reason || 'manual');
        ctx.gamesCache.invalidateAll();
        log.info(`🚫 [ADMIN] Partida anulada manualmente: ${fullId}`);
        res.json({ status: 'voided', gameId: fullId });
    }));

    /**
     * Re-renderiza y vuelve a publicar una partida YA guardada (Fase A4):
     * red de seguridad para cuando el render o la publicación fallaron
     * DESPUÉS del save-first (ver report/pipeline.js) — la partida quedó
     * persistida pero el cliente nunca vio el PNG en Discord/WhatsApp.
     * Idempotente: usa `dedupe_key = game_image:<canal>:<gameId>`, igual que
     * el pipeline, así que republicar dos veces no manda dos imágenes si el
     * outbox sigue teniendo la fila original pendiente/enviada.
     * POST /api/admin/games/:id/republish
     */
    router.post('/api/admin/games/:id/republish', adminAuth, asyncHandler(async (req, res) => {
        const fullId = await resolveGameId(ctx, req.params.id, res);
        if (!fullId) return;

        const record = await ctx.supabase.getGameWithPlayers(fullId);
        if (!record) return res.status(404).json({ error: `No existe partida con ID '${fullId}'` });

        const gameData = dbRowToGameData(record.game);
        const players = record.players.map(dbRowToPlayer);
        const format = record.game.format || classifyFormat(players);
        if (!FORMATS.includes(format)) {
            return res.status(422).json({ error: 'No se pudo determinar el formato (2v2/4v4) de esta partida' });
        }

        const pngPath = path.join(ctx.outputDir, `match_${fullId}.png`);
        await ctx.renderer.generatePNG(gameData, players, pngPath);

        const outboxEnabled = !!(ctx.config?.OUTBOX_ENABLED && ctx.outboxStore);
        const discordSvc = format === '2v2' ? ctx.discord : ctx.discord4v4;
        const discordChannel = format === '2v2' ? 'discord' : 'discord4v4';
        const publish = {};

        publish.discord = await publishRow(ctx, {
            kind: 'game_image', channel: discordChannel,
            dedupe_key: `game_image:${discordChannel}:${fullId}`,
            payload: { gameId: fullId, imagePath: pngPath, format, gameData, players },
        }, async () => {
            const ok = await discordSvc.sendImage(pngPath, gameData, players);
            return ok ? 'sent' : 'failed';
        });

        const chatId = ctx.whatsapp.groupIdFor(format);
        if (!chatId) {
            publish.whatsapp = 'skipped';
        } else {
            const { winnerLine, mapLine, dateStr, timeStr, shortId } = buildCaptionParts(gameData, players);
            const waCaption = `🏆 *${winnerLine}*\n${mapLine}\n${dateStr} ${timeStr} hrs (CDMX)\nID: ${shortId}`;
            publish.whatsapp = await publishRow(ctx, {
                kind: 'game_image', channel: 'whatsapp',
                dedupe_key: `game_image:whatsapp:${fullId}`,
                payload: { gameId: fullId, imagePath: pngPath, caption: waCaption, format },
            }, async () => {
                if (!ctx.whatsapp.isReady()) return 'failed';
                const ok = await ctx.whatsapp.sendImage(pngPath, waCaption, chatId);
                return ok ? 'sent' : 'failed';
            });
        }

        log.info(`🔁 [ADMIN] Partida republicada: ${fullId} (${format}) ${outboxEnabled ? '(outbox)' : '(directo)'}`);
        res.json({ status: 'republished', gameId: fullId, format, publish });
    }));

    /**
     * Mapas sin identificar: códigos crudos vistos que aún no tienen nombre.
     * Para recopilarlos y luego mapearlos. GET /api/admin/unknown-maps
     */
    router.get('/api/admin/unknown-maps', adminAuth, asyncHandler(async (req, res) => {
        const { data, error } = await ctx.supabase.client
            .from('games')
            .select('map_code, timestamp')
            .not('map_code', 'is', null);
        if (error) throw error;

        const known = new Set(Object.keys(MAP_NAMES));
        const counts = {};
        for (const g of data || []) {
            if (known.has(g.map_code)) continue;
            if (!counts[g.map_code]) counts[g.map_code] = { code: g.map_code, count: 0, lastSeen: g.timestamp };
            counts[g.map_code].count++;
            if (g.timestamp > counts[g.map_code].lastSeen) counts[g.map_code].lastSeen = g.timestamp;
        }
        res.json(Object.values(counts).sort((a, b) => b.count - a.count));
    }));

    /**
     * Backfill: aplica un nombre a todas las partidas con un map_code dado.
     * Se usa tras agregar el código a utils/maps.js (para corregir partidas viejas).
     * POST /api/admin/map-backfill  Body: { code, name }
     */
    router.post('/api/admin/map-backfill', adminAuth, asyncHandler(async (req, res) => {
        const code = String(req.body?.code || '').trim().toLowerCase();
        const name = String(req.body?.name || '').trim();
        if (!code || !name) return res.status(400).json({ error: 'Faltan code y/o name' });

        const { data, error } = await ctx.supabase.client
            .from('games')
            .update({ map_name: name })
            .eq('map_code', code)
            .select('game_unique_id');
        if (error) throw error;
        ctx.gamesCache.invalidateAll();
        res.json({ status: 'ok', code, name, updated: (data || []).length });
    }));

    return router;
}

module.exports = { createAdminGamesRouter, resolveGameId };
