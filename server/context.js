/**
 * Construcción del contexto compartido (Fase A2). `ctx` es lo único que las
 * rutas (server/http/routes/*), la tubería de reportes y los comandos de
 * WhatsApp reciben: nada de singletons de módulo salvo donde ya existían
 * (server/alerts.js).
 */

'use strict';

const { makeLock } = require('./state/locks');
const { createGamesCache } = require('./domain/gamesCache');
const { createOutboxStore } = require('./messaging/outboxStore');
const { createOutboxWorker } = require('./messaging/outbox');
const { getRondasGames } = require('./domain/rondas');
const { currentOrLastSession, formatLiveRoundUpdate } = require('./utils/sessions');
const { applySaldosSentSideEffects } = require('./domain/saldos');

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
    const ctx = {
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

    // Fase A4 — "guardar primero + outbox persistente", detrás de
    // OUTBOX_ENABLED (default false). `outboxStore` funciona igual (lanza
    // OutboxUnavailableError) tanto si Supabase no está configurado como si
    // la tabla `outbox` todavía no existe (migración manual, ver
    // supabase_schema.sql) — así que crearlo siempre que esté habilitado es
    // seguro, nunca truena el arranque.
    if (config.OUTBOX_ENABLED) {
        ctx.outboxStore = createOutboxStore(services.supabase.client);
        ctx.outboxWorker = createOutboxWorker({
            store: ctx.outboxStore,
            port: services.whatsapp,
            discord: services.discord,
            discord4v4: services.discord4v4,
            alerts,
            logger,
            pollMs: config.OUTBOX_POLL_MS,
            maxAttempts: config.OUTBOX_MAX_ATTEMPTS,
            // El texto del marcador de ronda se calcula AL MOMENTO DE ENVIAR
            // (no al encolar), para reflejar el estado más reciente.
            getRoundUpdateText: async () => {
                const rondasGames = await getRondasGames(ctx);
                return formatLiveRoundUpdate(currentOrLastSession(rondasGames));
            },
            // Reset de saldos SOLO tras el envío confirmado (ver domain/saldos.js);
            // se reconoce la fila por payload.meta.action, puesto ahí al encolar.
            onSent: async (row) => {
                if (row.kind === 'text' && row.payload?.meta?.action === 'saldos_cut') {
                    await applySaldosSentSideEffects(ctx, row.payload.meta);
                }
            },
        });
    }

    return ctx;
}

module.exports = { buildCtx };
