/**
 * Scheduler
 * Tareas programadas del servidor (node-cron con timezone explícita).
 */

const cron = require('node-cron');

const WEEKLY_MESSAGE = '¿Habrá revancha?';

/**
 * Programa las tareas semanales de los lunes (hora CDMX), SOLO WhatsApp:
 *  - 09:00 corte de saldos de la semana (callback provisto por index.js:
 *    manda los saldos al grupo 2v2 y reinicia el marcador)
 *  - 10:00 mensaje "¿Habrá revancha?"
 * @param {WhatsAppService} whatsapp
 * @param {{ sendWeeklySaldos?: function }} [jobs]
 */
function startSchedules(whatsapp, jobs = {}) {
    if (typeof jobs.sendWeeklySaldos === 'function') {
        // Cada hora de 09:00 a 23:00 del lunes: el primer intento que logre
        // enviar hace el corte; los siguientes son no-op (guard "ya corrido
        // hoy" en el job). Así un reinicio del servidor a las 09:00 no deja
        // la semana sin corte.
        cron.schedule('0 9-23 * * 1', async () => {
            console.log('⏰ Cron semanal: corte de saldos (lunes, CDMX)...');
            try {
                const result = await jobs.sendWeeklySaldos();
                console.log(`💰 Corte de saldos: ${JSON.stringify(result)}`);
            } catch (error) {
                console.error('❌ Corte de saldos falló:', error.message);
            }
        }, { timezone: 'America/Mexico_City' });
        console.log('🗓️  Programado: corte de saldos los lunes 09:00 (CDMX, reintentos por hora hasta 23:00) -> grupo 2v2');
    }

    cron.schedule('0 10 * * 1', async () => {
        console.log(`⏰ Cron semanal: enviando "${WEEKLY_MESSAGE}" a WhatsApp (Retas H3 / 2v2)...`);
        if (!whatsapp.isReady()) {
            console.log('⚠️  WhatsApp no está listo; mensaje semanal omitido esta vez');
            return;
        }
        const chatId = whatsapp.groupIdFor('2v2');
        if (!chatId) {
            console.log('⚠️  Sin grupo 2v2 configurado; mensaje semanal omitido');
            return;
        }
        const ok = await whatsapp.sendMessage(WEEKLY_MESSAGE, chatId);
        console.log(ok ? '✅ Mensaje semanal enviado' : '❌ Falló el envío del mensaje semanal');
    }, { timezone: 'America/Mexico_City' });

    console.log(`🗓️  Programado: "${WEEKLY_MESSAGE}" cada lunes 10:00 (CDMX) -> grupo 2v2`);
}

module.exports = { startSchedules, WEEKLY_MESSAGE };
