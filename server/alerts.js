/**
 * Alertas operativas a Discord (Fase A1 — observabilidad).
 *
 * Canal SEPARADO del de resultados de partidas: usa DISCORD_ALERT_WEBHOOK_URL
 * si está configurado, y si no cae al mismo DISCORD_WEBHOOK_URL de siempre
 * (2v2 / Retas H3) para no quedarse sin avisos en instalaciones que todavía
 * no configuraron un webhook dedicado.
 *
 * `alert(level, text, opts)` nunca lanza (best-effort, como el resto de los
 * envíos a Discord/WhatsApp del proyecto) y deduplica por `key` dentro de
 * `cooldownMs` (default 30 min) para no inundar el canal si algo falla en
 * bucle (p.ej. un cron que truena cada minuto).
 */

'use strict';

const DiscordService = require('./services/discord');
const { logger } = require('./logger');

const log = logger.child({ mod: 'alerts' });

const LEVEL_PREFIX = { error: '🔴', warn: '🟠', info: '🟢' };
const DEFAULT_COOLDOWN_MS = 30 * 60 * 1000;

/**
 * URL del webhook de alertas: DISCORD_ALERT_WEBHOOK_URL, o si no está
 * configurado, el DISCORD_WEBHOOK_URL general. Función pura (recibe el env
 * como parámetro) para poder probar el fallback sin tocar el proceso real.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string|undefined}
 */
function resolveWebhookUrl(env = process.env) {
    return env.DISCORD_ALERT_WEBHOOK_URL || env.DISCORD_WEBHOOK_URL || undefined;
}

/**
 * Crea una instancia de alertas con dedupe propio (Map en memoria). Se usa
 * un factory (en vez de un singleton fijo) para poder inyectar un
 * DiscordService falso en tests sin tocar la red.
 * @param {{ sendMessage: (text: string) => Promise<boolean>|boolean }} discord
 * @returns {{ alert: function }}
 */
function createAlerts(discord) {
    const lastSentAt = new Map(); // key -> epoch ms del último envío

    /**
     * @param {'error'|'warn'|'info'} level
     * @param {string} text
     * @param {{ key?: string, cooldownMs?: number }} [opts]
     * @returns {Promise<boolean>} true si se envió (false si se dedupeó, no
     *   había webhook configurado, o el envío falló)
     */
    async function alert(level, text, { key, cooldownMs = DEFAULT_COOLDOWN_MS } = {}) {
        try {
            const now = Date.now();
            if (key) {
                const last = lastSentAt.get(key);
                if (last !== undefined && now - last < cooldownMs) {
                    return false; // dedupeado: ya se avisó de esto hace poco
                }
                lastSentAt.set(key, now);
            }

            const prefix = LEVEL_PREFIX[level] || LEVEL_PREFIX.info;
            const ok = await discord.sendMessage(`${prefix} ${text}`);
            if (!ok) {
                log.warn({ level, key }, '⚠️  No se pudo enviar la alerta a Discord (webhook falló o no configurado)');
            }
            return ok;
        } catch (err) {
            log.warn({ err, level, key }, '⚠️  alert() lanzó un error inesperado, se ignora');
            return false;
        }
    }

    return { alert };
}

// Instancia por default del proceso, contra el webhook de alertas real.
const defaultAlerts = createAlerts(new DiscordService(resolveWebhookUrl()));

module.exports = { alert: defaultAlerts.alert, createAlerts, resolveWebhookUrl };
