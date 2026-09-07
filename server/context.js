/**
 * Construcción del contexto compartido (Fase A2). `ctx` es lo único que las
 * rutas (server/http/routes/*), la tubería de reportes y los comandos de
 * WhatsApp reciben: nada de singletons de módulo salvo donde ya existían
 * (server/alerts.js).
 */

'use strict';

const { makeLock } = require('./state/locks');
const { createGamesCache } = require('./domain/gamesCache');

function buildLocks() {
    return {
        withRosterLock: makeLock(),
        withForfeitLock: makeLock(),
        withAnularLock: makeLock(),
        withAjusteLock: makeLock(),
        withSaldosLock: makeLock(),
    };
}

/**
 * @param {object} opts
 * @param {object} opts.config
 * @param {import('pino').Logger} opts.logger
 * @param {{discord: object, discord4v4: object, supabase: object, renderer: object, whatsapp: object}} opts.services
 * @param {{alert: function}} opts.alerts
 * @param {string} opts.outputDir
 * @param {string} opts.version
 * @param {() => Array<{name: string, status: string}>} opts.getSchedulerJobs
 */
function buildCtx({ config, logger, services, alerts, outputDir, version, getSchedulerJobs }) {
    return {
        config,
        logger,
        ...services,
        // `port` es el mismo MessagingPort que `whatsapp` (Fase A3): el nombre
        // `whatsapp` se conserva porque report/pipeline.js, domain/saldos.js,
        // jobs/* y health.js ya lo usan así; `port` es el nombre "de contrato"
        // para código nuevo que programe contra server/messaging/port.js.
        port: services.whatsapp,
        alerts,
        outputDir,
        gamesCache: createGamesCache({ supabase: services.supabase }),
        locks: buildLocks(),
        version,
        getSchedulerJobs,
    };
}

module.exports = { buildCtx };
