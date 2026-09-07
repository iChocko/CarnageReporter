/**
 * Scheduler
 * Tareas programadas del servidor (node-cron con timezone explícita).
 */

const cron = require('node-cron');
const { logger } = require('../logger');
const { alert } = require('../alerts');

const log = logger.child({ mod: 'scheduler' });

const WEEKLY_MESSAGE = '¿Habrá revancha?';

/**
 * Programa las tareas semanales de los lunes (hora CDMX), SOLO WhatsApp:
 *  - 09:00 corte de saldos de la semana (callback provisto por index.js:
 *    manda los saldos al grupo 2v2 y reinicia el marcador)
 *  - 10:00 mensaje "¿Habrá revancha?"
 * Y las tareas diarias de mantenimiento (Fase A0, red de seguridad):
 *  - 03:30 backup del estado local (jobs/backup.js)
 *  - 03:45 limpieza de PNGs viejos en output/ (jobs/cleanup.js)
 *
 * Cualquier excepción no atrapada dentro de un job dispara una alerta a
 * Discord (server/alerts.js, key `cron:<job>`) además de loggearse: un cron
 * que truena en silencio a las 3am no lo nota nadie hasta que ya duele.
 *
 * @param {WhatsAppService} whatsapp
 * @param {{ sendWeeklySaldos?: function, runBackup?: function, runCleanup?: function }} [jobs]
 * @returns {{ tasks: Array<{name: string, task: import('node-cron').ScheduledTask}>, stopAll: function }}
 *   Referencias a las tareas programadas (para el apagado limpio y para
 *   reportar su estado en /api/health) y un atajo para detenerlas todas.
 */
function startSchedules(whatsapp, jobs = {}) {
    const tasks = [];

    if (typeof jobs.sendWeeklySaldos === 'function') {
        // Cada hora de 09:00 a 23:00 del lunes: el primer intento que logre
        // enviar hace el corte; los siguientes son no-op (guard "ya corrido
        // hoy" en el job). Así un reinicio del servidor a las 09:00 no deja
        // la semana sin corte.
        const task = cron.schedule('0 9-23 * * 1', async () => {
            log.info('⏰ Cron semanal: corte de saldos (lunes, CDMX)...');
            try {
                const result = await jobs.sendWeeklySaldos();
                log.info(`💰 Corte de saldos: ${JSON.stringify(result)}`);
            } catch (error) {
                log.error({ err: error }, '❌ Corte de saldos falló');
                alert('error', `Cron "saldos" falló: ${error.message}`, { key: 'cron:saldos' });
            }
        }, { timezone: 'America/Mexico_City' });
        tasks.push({ name: 'saldos', task });
        log.info('🗓️  Programado: corte de saldos los lunes 09:00 (CDMX, reintentos por hora hasta 23:00) -> grupo 2v2');
    }

    const weeklyMessageTask = cron.schedule('0 10 * * 1', async () => {
        log.info(`⏰ Cron semanal: enviando "${WEEKLY_MESSAGE}" a WhatsApp (Retas H3 / 2v2)...`);
        try {
            if (!whatsapp.isReady()) {
                log.warn('⚠️  WhatsApp no está listo; mensaje semanal omitido esta vez');
                return;
            }
            const chatId = whatsapp.groupIdFor('2v2');
            if (!chatId) {
                log.warn('⚠️  Sin grupo 2v2 configurado; mensaje semanal omitido');
                return;
            }
            const ok = await whatsapp.sendMessage(WEEKLY_MESSAGE, chatId);
            log.info(ok ? '✅ Mensaje semanal enviado' : '❌ Falló el envío del mensaje semanal');
        } catch (error) {
            log.error({ err: error }, '❌ Cron del mensaje semanal falló');
            alert('error', `Cron "mensaje-semanal" falló: ${error.message}`, { key: 'cron:mensaje-semanal' });
        }
    }, { timezone: 'America/Mexico_City' });
    tasks.push({ name: 'mensaje-semanal', task: weeklyMessageTask });

    log.info(`🗓️  Programado: "${WEEKLY_MESSAGE}" cada lunes 10:00 (CDMX) -> grupo 2v2`);

    if (typeof jobs.runBackup === 'function') {
        const task = cron.schedule('30 3 * * *', async () => {
            log.info('⏰ Cron diario: backup de estado...');
            try {
                const result = await jobs.runBackup();
                log.info(`💾 Backup de estado: ${JSON.stringify(result)}`);
            } catch (error) {
                log.error({ err: error }, '❌ Backup de estado falló');
                alert('error', `Cron "backup" falló: ${error.message}`, { key: 'cron:backup' });
            }
        }, { timezone: 'America/Mexico_City' });
        tasks.push({ name: 'backup', task });
        log.info('🗓️  Programado: backup diario de estado 03:30 (CDMX)');
    }

    if (typeof jobs.runCleanup === 'function') {
        const task = cron.schedule('45 3 * * *', async () => {
            log.info('⏰ Cron diario: limpieza de PNGs viejos...');
            try {
                const result = await jobs.runCleanup();
                log.info(`🧹 Limpieza de output/: ${JSON.stringify(result)}`);
            } catch (error) {
                log.error({ err: error }, '❌ Limpieza de output/ falló');
                alert('error', `Cron "cleanup" falló: ${error.message}`, { key: 'cron:cleanup' });
            }
        }, { timezone: 'America/Mexico_City' });
        tasks.push({ name: 'cleanup', task });
        log.info('🗓️  Programado: limpieza diaria de PNGs viejos 03:45 (CDMX)');
    }

    return {
        tasks,
        stopAll() {
            for (const { task } of tasks) {
                try { task.stop(); } catch { /* ya detenida */ }
            }
        },
    };
}

module.exports = { startSchedules, WEEKLY_MESSAGE };
