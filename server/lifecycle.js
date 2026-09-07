/**
 * Apagado limpio y manejadores de proceso (Fase A2 — movidos tal cual desde
 * el final de index.js).
 */

'use strict';

const { logger } = require('./logger');

const log = logger.child({ mod: 'http' });

/**
 * @param {object} opts
 * @param {import('./messaging/port').MessagingPort} opts.whatsapp
 * @param {{ alert: function }} opts.alerts
 * @param {() => import('http').Server|null} opts.getHttpServer
 * @param {() => {stopAll: function}|null} opts.getSchedulerHandle
 * @returns {{ shutdown: function, registerProcessHandlers: function }}
 */
function createLifecycle({ whatsapp, alerts, getHttpServer, getSchedulerHandle }) {
    let shuttingDown = false;

    /**
     * Apagado limpio (Fase A1): cierra el servidor HTTP (deja de aceptar
     * conexiones nuevas), detiene los cron jobs, destruye la sesión de
     * WhatsApp y vacía el logger antes de salir con código 0. Plazo duro de
     * 15s: si algo se cuelga (p.ej. whatsapp.stop() esperando a
     * Chromium), se fuerza la salida con código 1 en vez de dejar el proceso
     * colgado para siempre (Docker con `restart: always` lo vuelve a
     * levantar de todos modos).
     */
    async function shutdown(signal) {
        if (shuttingDown) return;
        shuttingDown = true;
        log.info(`👋 Cerrando servidor (${signal})...`);

        const hardDeadline = setTimeout(() => {
            log.error('⏱️  El apagado no terminó en 15s, forzando salida');
            process.exit(1);
        }, 15000);
        hardDeadline.unref();

        try {
            const httpServer = getHttpServer();
            if (httpServer) {
                await new Promise((resolve) => httpServer.close(() => resolve()));
            }
            const schedulerHandle = getSchedulerHandle();
            if (schedulerHandle) schedulerHandle.stopAll();
            await whatsapp.stop();
            log.info('👋 Servidor cerrado limpiamente');
            clearTimeout(hardDeadline);
            logger.flush();
            process.exit(0);
        } catch (err) {
            log.error({ err }, '❌ Error durante el apagado');
            clearTimeout(hardDeadline);
            process.exit(1);
        }
    }

    /**
     * uncaughtException: una excepción síncrona escapó de cualquier try/catch, así
     * que el estado del proceso queda indeterminado (Node mismo lo recomienda:
     * no es seguro seguir corriendo). Se loggea como fatal, se manda una alerta a
     * Discord (server/alerts.js) y el proceso sale con código 1 tras una pausa
     * breve para darle tiempo a esa alerta de salir antes de que el proceso
     * muera. Docker con `restart: always` levanta el contenedor de nuevo.
     */
    function fatal(kind, err) {
        log.fatal({ err }, `💀 ${kind} no manejado — el proceso va a salir`);
        alerts.alert('error', `${kind} no manejado: ${err?.message || err}. El proceso se reinicia.`, { key: 'process' })
            .finally(() => setTimeout(() => process.exit(1), 2000));
    }

    function registerProcessHandlers() {
        process.on('SIGINT', () => shutdown('SIGINT'));
        process.on('SIGTERM', () => shutdown('SIGTERM'));

        // unhandledRejection: whatsapp-web.js + Puppeteer sueltan promesas rechazadas
        // sin manejar con frecuencia durante reconexiones/reinicios de sesión
        // ("Protocol error: Target closed", "Execution context was destroyed",
        // "Session closed") sin que el proceso quede en mal estado — a diferencia de
        // uncaughtException, aquí el resto del programa sigue siendo confiable. Salir
        // del proceso por cada una de esas fugas conocidas convertiría un log inocuo
        // en un bucle de reinicios con 1-2 min de caída de WhatsApp cada vez, así que
        // solo se loggea y se alerta (con cooldown de dedupe) sin tumbar el proceso.
        process.on('unhandledRejection', (reason) => {
            const err = reason instanceof Error ? reason : new Error(String(reason));
            log.error({ err }, '⚠️  promesa rechazada sin manejar');
            alerts.alert('warn', `unhandledRejection: ${err.message || err}`, { key: 'process:unhandledRejection' });
        });
        process.on('uncaughtException', (err) => {
            fatal('uncaughtException', err);
        });
    }

    return { shutdown, registerProcessHandlers };
}

module.exports = { createLifecycle };
