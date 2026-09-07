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

// Comparación segmento a segmento (major.minor.patch), como
// client/src/updater.js#isNewerVersion pero en dirección inversa: aquí
// interesa saber si `current` se quedó ATRÁS de `min`.
function parseVersionParts(v) {
    return String(v || '0.0.0').replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
}

function isVersionLower(current, min) {
    const c = parseVersionParts(current);
    const m = parseVersionParts(min);
    for (let i = 0; i < 3; i++) {
        const cv = c[i] || 0;
        const mv = m[i] || 0;
        if (cv < mv) return true;
        if (cv > mv) return false;
    }
    return false;
}

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
        const installId = req.headers['x-install-id'] || null;
        const gamertagHint = req.headers['x-gamertag-hint'] || null;
        const userAgent = req.headers['user-agent'] || null;

        // Fase B3: instalaciones puntuales revocadas (reportes corruptos, copia
        // mal configurada) se cortan aquí, antes de tocar la BD, sin invalidar
        // la API key que comparten el resto de las instalaciones.
        const revoked = ctx.config.REVOKED_INSTALL_IDS;
        if (installId && revoked && revoked.length && revoked.includes(installId)) {
            reportLog.warn(`🚫 Instalación revocada intentó reportar: ${installId}`);
            return res.status(403).json({ status: 'revoked', error: 'Instalación revocada' });
        }

        // Cliente por debajo de la versión mínima aceptada: sin clientVersion
        // se asume 0.0.0 (peor caso) SOLO cuando la variable está configurada,
        // para no romper clientes v1/v2 que nunca mandaron este campo.
        const minVersion = ctx.config.CLIENT_MIN_VERSION;
        if (minVersion && isVersionLower(clientVersion || '0.0.0', minVersion)) {
            return res.status(426).json({ status: 'upgrade_required', minVersion });
        }

        const validationError = validateReportPayload(gameData, players, {
            installId: req.body.installId, clientSentAt: req.body.clientSentAt
        });
        if (validationError) {
            return res.status(400).json({ error: validationError });
        }

        const gameId = gameData.gameUniqueId;
        reportLog.info(`\n📥 Recibido reporte: ${gameId} (${gameData.mapName}) [v${schemaVersion}${clientVersion ? `, cliente ${clientVersion}` : ''}, ${players.length} jugadores]`
            + `${installId ? ` install=${installId}` : ''}${gamertagHint ? ` gamertag=${gamertagHint}` : ''}${userAgent ? ` ua="${userAgent}"` : ''}`);

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
            const result = await processReport({
                gameData, players, filename, schemaVersion, clientVersion,
                installId: req.body.installId || installId, clientSentAt: req.body.clientSentAt
            }, ctx);
            res.json(result);
        } finally {
            inFlightReports.delete(gameId);
        }
    }));

    return router;
}

module.exports = { createReportRouter };
