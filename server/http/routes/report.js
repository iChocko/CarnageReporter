/**
 * POST /api/report (Fase A2 — movido tal cual desde index.js).
 *
 * La ruta hace auth/rate-limit y el candado en memoria contra reportes
 * simultáneos del mismo juego; el resto de la lógica vive en
 * server/report/pipeline.js (processReport).
 */

'use strict';

const express = require('express');
const { asyncHandler } = require('../errors');
const { authMiddleware } = require('../auth');
const { reportLimiter } = require('../limiters');
const { validateReportPayload } = require('../../report/validatePayload');
const { processReport, reportLog } = require('../../report/pipeline');

/**
 * @param {object} ctx - contexto compartido (ver server/index.js)
 */
function createReportRouter(ctx) {
    const router = express.Router();

    // Varios jugadores de la misma partida corren el cliente, así que el mismo
    // gameUniqueId llega 2+ veces con segundos de diferencia. El chequeo contra
    // la BD no cubre ese caso (la partida se guarda hasta el final, tras render
    // y envíos): el primer reporte toma el candado y los simultáneos rebotan aquí.
    const inFlightReports = new Set();

    /**
     * Recibir reporte de partida
     * POST /api/report
     * Body: { gameData, players, filename }
     */
    router.post('/api/report', reportLimiter, authMiddleware(ctx.config), asyncHandler(async (req, res) => {
        const { gameData, players, filename } = req.body;
        const schemaVersion = parseInt(req.body.schemaVersion || 1, 10);
        const clientVersion = req.body.clientVersion || null;

        const validationError = validateReportPayload(gameData, players);
        if (validationError) {
            return res.status(400).json({ error: validationError });
        }

        const gameId = gameData.gameUniqueId;
        reportLog.info(`\n📥 Recibido reporte: ${gameId} (${gameData.mapName}) [v${schemaVersion}${clientVersion ? `, cliente ${clientVersion}` : ''}, ${players.length} jugadores]`);

        if (inFlightReports.has(gameId)) {
            reportLog.info(`⏭️  Juego ${gameId} ya está en proceso (reporte simultáneo de otro cliente), saltando`);
            return res.json({
                status: 'duplicate',
                gameId,
                message: 'Este juego ya está siendo procesado'
            });
        }
        inFlightReports.add(gameId);

        try {
            const result = await processReport({ gameData, players, filename, schemaVersion, clientVersion }, ctx);
            res.json(result);
        } finally {
            inFlightReports.delete(gameId);
        }
    }));

    return router;
}

module.exports = { createReportRouter };
