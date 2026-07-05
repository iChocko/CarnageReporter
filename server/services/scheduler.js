/**
 * Scheduler
 * Tareas programadas del servidor (node-cron con timezone explícita).
 */

const cron = require('node-cron');

const WEEKLY_MESSAGE = '¿Habrá revancha?';

/**
 * Programa el mensaje semanal de los lunes 10:00 (hora CDMX), SOLO WhatsApp.
 * @param {WhatsAppService} whatsapp
 */
function startSchedules(whatsapp) {
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
