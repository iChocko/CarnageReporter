/**
 * Construcción de las instancias de servicios externos (Fase A2 — antes al
 * principio de index.js). Cada servicio sigue leyendo su propio process.env
 * donde ya lo hacía (whatsapp.js, supabase.js, y DiscordService cuando no se
 * le pasa webhookUrl); esto solo agrupa las llamadas a `new`.
 */

'use strict';

const DiscordService = require('./discord');
const SupabaseService = require('./supabase');
const RendererService = require('./renderer');
const WhatsAppService = require('./whatsapp');

/**
 * @param {object} config - ver server/config.js
 */
function createServices(config) {
    return {
        discord: new DiscordService(), // 2v2 -> canal Retas H3
        discord4v4: new DiscordService(config.DISCORD_WEBHOOK_URL_4V4), // 4v4 -> canal de validación
        supabase: new SupabaseService(),
        renderer: new RendererService(),
        whatsapp: new WhatsAppService(),
    };
}

module.exports = { createServices };
