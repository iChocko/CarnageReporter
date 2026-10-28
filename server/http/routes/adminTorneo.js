/**
 * Panel admin del torneo (organizadores). Autenticación con ADMIN_KEY o con
 * una clave individual de organizador (tabla torneo_accesos en Supabase,
 * acotada a estas rutas). Todo se guarda en
 * output/torneo.json vía domain/torneo.js y se recalcula al leer.
 */

'use strict';

const express = require('express');
const { asyncHandler } = require('../errors');
const { torneoAdminAuthMiddleware } = require('../auth');
const { resolveGameId } = require('./adminGames');
const torneo = require('../../domain/torneo');
const { createAccesoLookup } = require('../../domain/torneoAccesos');

function createAdminTorneoRouter(ctx) {
    const router = express.Router();
    const auth = torneoAdminAuthMiddleware(ctx.config, createAccesoLookup(ctx.supabase));
    const log = ctx.logger.child({ mod: 'http' });
    const porDe = req => `web:${req.adminName || req.adminRole}`;

    /**
     * Config cruda + cálculo completo (con candidatas) + rol de quien pide.
     * GET /api/admin/torneo
     */
    router.get('/api/admin/torneo', auth, asyncHandler(async (req, res) => {
        const config = torneo.loadRawConfig(ctx.outputDir);
        const result = config ? await torneo.getTorneoResult(ctx, { includeInactive: true }) : null;
        res.json({ role: req.adminRole, nombre: req.adminName, config, result });
    }));

    /**
     * Reemplaza la config completa (los overrides se conservan si el body no
     * los trae). 400 con el motivo si no valida.
     * PUT /api/admin/torneo
     */
    router.put('/api/admin/torneo', auth, asyncHandler(async (req, res) => {
        let saved;
        try {
            saved = torneo.saveConfig(ctx.outputDir, req.body);
        } catch (err) {
            return res.status(400).json({ error: err.message });
        }
        ctx.gamesCache.invalidateAll();
        log.info(`🏆 [ADMIN] Config del torneo actualizada (${porDe(req)})`);
        res.json({ status: 'ok', config: saved });
    }));

    /**
     * Agrega un override: { tipo: excluir|fijar|resultado|wo|cancelar,
     * gameId?, serie?, slot?, ganador?, nota? }. gameId acepta el ID corto.
     * POST /api/admin/torneo/overrides
     */
    router.post('/api/admin/torneo/overrides', auth, asyncHandler(async (req, res) => {
        const body = { ...(req.body || {}) };
        if (body.gameId) {
            const fullId = await resolveGameId(ctx, body.gameId, res);
            if (!fullId) return;
            body.gameId = fullId;
        }
        try {
            const entry = await torneo.addOverride(ctx, body, porDe(req));
            res.json({ status: 'ok', override: entry });
        } catch (err) {
            if (err.status) return res.status(err.status).json({ error: err.message });
            throw err;
        }
    }));

    /**
     * Deshace un override.
     * DELETE /api/admin/torneo/overrides/:id
     */
    router.delete('/api/admin/torneo/overrides/:id', auth, asyncHandler(async (req, res) => {
        const removed = await torneo.removeOverride(ctx, req.params.id);
        if (!removed) return res.status(404).json({ error: 'No existe ese override' });
        res.json({ status: 'ok', removed });
    }));

    /**
     * Asigna un gamertag (cuenta alterna) a un jugador.
     * POST /api/admin/torneo/gamertags { equipo, jugador, gamertag }
     */
    router.post('/api/admin/torneo/gamertags', auth, asyncHandler(async (req, res) => {
        try {
            const out = await torneo.addGamertag(ctx, req.body || {});
            res.json({ status: 'ok', ...out });
        } catch (err) {
            if (err.status) return res.status(err.status).json({ error: err.message });
            throw err;
        }
    }));

    return router;
}

module.exports = { createAdminTorneoRouter };
