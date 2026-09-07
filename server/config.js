/**
 * Configuración del servidor (Fase A2 — partir index.js).
 *
 * Toda lectura de process.env que antes vivía directamente en index.js se
 * concentra aquí, se valida UNA sola vez al arrancar, y se expone como un
 * objeto congelado. Los módulos que ya leían su propio process.env (los
 * servicios, utils/*, alerts.js) lo siguen haciendo igual: esto NO es una
 * capa de config global del proyecto, solo mueve lo que index.js leía.
 *
 * `loadConfig` lanza si falta API_KEY (igual que antes, que hacía
 * `process.exit(1)` inline) para que quien llame decida cómo loggear y
 * salir — hoy eso lo hace server/index.js.
 */

'use strict';

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Readonly<object>}
 */
function loadConfig(env = process.env) {
    const API_KEY = env.API_KEY;
    if (!API_KEY) {
        throw new Error('Falta la variable de entorno API_KEY. Configúrala en el .env antes de iniciar.');
    }

    return Object.freeze({
        PORT: env.PORT || 3000,
        API_KEY,
        ADMIN_KEY: env.ADMIN_KEY,
        STRIPE_SECRET_KEY: env.STRIPE_SECRET_KEY,
        DISCORD_WEBHOOK_URL: env.DISCORD_WEBHOOK_URL,
        DISCORD_WEBHOOK_URL_4V4: env.DISCORD_WEBHOOK_URL_4V4,
        // WHATSAPP_ADMIN_IDS es el nombre nuevo (Fase A3); WHATSAPP_ADMIN_JIDS
        // sigue funcionando (mismo formato: JIDs separados por coma). Si
        // vienen los dos, ambos se toman en cuenta (unión, sin duplicar).
        WHATSAPP_ADMIN_JIDS: env.WHATSAPP_ADMIN_JIDS || '',
        WHATSAPP_ADMIN_IDS: env.WHATSAPP_ADMIN_IDS || '',
        WHATSAPP_ADMINS_FROM_GROUP: env.WHATSAPP_ADMINS_FROM_GROUP === 'true',
        WHATSAPP_ENABLED: env.WHATSAPP_ENABLED,
        WHATSAPP_TRANSPORT: env.WHATSAPP_TRANSPORT || 'wwebjs',
        WHATSAPP_SHADOW_TRANSPORT: env.WHATSAPP_SHADOW_TRANSPORT || '',
        // Ventana de vigencia de un comando entrante (segundos). Un mensaje
        // más viejo se ignora sin correr el handler: evita que el historial
        // reproducido tras una reconexión dispare un "!rondas reset" viejo.
        COMMAND_MAX_AGE_S: Number(env.COMMAND_MAX_AGE_S) > 0 ? Number(env.COMMAND_MAX_AGE_S) : 120,
        LEADERBOARD_MIN_GAMES: env.LEADERBOARD_MIN_GAMES,
        CORS_ORIGIN: env.CORS_ORIGIN,
        BACKUP_INCLUDE_AUTH: env.BACKUP_INCLUDE_AUTH === 'true',
    });
}

module.exports = { loadConfig };
