/**
 * GET /api/health y /api/status (Fase A2 — movidos tal cual desde index.js).
 */

'use strict';

const express = require('express');
const { asyncHandler } = require('../errors');
const { createHealthCheck } = require('../../health');

/**
 * @param {object} ctx - contexto compartido; además de lo habitual necesita
 *   `version` (versión reportada en el body) y `getSchedulerJobs` (closure
 *   sobre el handle del scheduler, asignado tras start() en index.js).
 */
function createHealthRouter(ctx) {
    const router = express.Router();

    /**
     * Health check (Fase A1). Lógica extraída a server/health.js para poder
     * probarla con dobles falsos (ver server/test/health.test.js); aquí solo se
     * inyectan las instancias reales. Cacheado 10s (default) por health.js;
     * 503 únicamente cuando Supabase falla, para no reiniciar el contenedor por
     * un estado normal de WhatsApp (waiting_qr/disconnected).
     */
    const health = createHealthCheck({
        supabase: ctx.supabase,
        whatsapp: ctx.whatsapp,
        renderer: ctx.renderer,
        getSchedulerJobs: ctx.getSchedulerJobs,
        outputDir: ctx.outputDir,
        version: ctx.version,
        alertFn: ctx.alerts.alert,
        outboxEnabled: !!ctx.config?.OUTBOX_ENABLED,
        outboxStore: ctx.outboxStore || null,
    });
    router.get('/api/health', asyncHandler(health.handler));

    /**
     * Estado del servidor
     */
    router.get('/api/status', (req, res) => {
        res.json({
            stats: {
                processed: ctx.supabase.getProcessedCount()
            }
        });
    });

    return router;
}

module.exports = { createHealthRouter };
