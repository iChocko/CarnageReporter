/**
 * Construcción de las instancias de servicios externos (Fase A2 — antes al
 * principio de index.js). Cada servicio sigue leyendo su propio process.env
 * donde ya lo hacía (el adaptador de mensajería, supabase.js, y DiscordService
 * cuando no se le pasa webhookUrl); esto solo agrupa las llamadas a `new`.
 *
 * `whatsapp` (Fase A3) ya no es SIEMPRE el cliente de whatsapp-web.js: es el
 * MessagingPort que elige `WHATSAPP_TRANSPORT` (ver server/messaging/index.js)
 * — 'wwebjs' por default, 'fake' en tests. El nombre `ctx.whatsapp` se
 * conserva por compatibilidad con report/pipeline.js, domain/saldos.js,
 * jobs/* y health.js, que lo siguen llamando igual que siempre.
 */

'use strict';

const DiscordService = require('./discord');
const SupabaseService = require('./supabase');
const RendererService = require('./renderer');
const { createMessagingPort } = require('../messaging');

/**
 * @param {object} config - ver server/config.js
 */
function createServices(config) {
    return {
        discord: new DiscordService(), // 2v2 -> canal Retas H3
        discord4v4: new DiscordService(config.DISCORD_WEBHOOK_URL_4V4), // 4v4 -> canal de validación
        supabase: new SupabaseService(),
        renderer: new RendererService(),
        whatsapp: createMessagingPort(config),
    };
}

module.exports = { createServices };
