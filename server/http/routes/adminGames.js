/**
 * Endpoints admin sobre partidas: void/unvoid/delete y mapas sin identificar
 * (Fase A2 — movidos tal cual desde index.js).
 */

'use strict';

const express = require('express');
const { asyncHandler } = require('../errors');
const { adminAuthMiddleware } = require('../auth');
const { MAP_NAMES } = require('../../utils/maps');
const { FORMATS } = require('../../utils/format');
const { logger } = require('../../logger');

const log = logger.child({ mod: 'http' });

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
