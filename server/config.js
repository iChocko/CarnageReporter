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
        // 'wwebjs' (default, producción hoy) | 'fake' (tests) | 'baileys' (Fase A5)
        WHATSAPP_TRANSPORT: env.WHATSAPP_TRANSPORT || 'wwebjs',
        // Segundo transporte en paralelo, modo solo-lectura (adapters/shadow.js):
        // '' (default, sin shadow) | 'fake' | 'baileys'.
        WHATSAPP_SHADOW_TRANSPORT: env.WHATSAPP_SHADOW_TRANSPORT || '',
        // Fase A5 — subcarpeta de sesión del adaptador de Baileys dentro de
        // WHATSAPP_AUTH_DIR (default 'baileys'; la instancia shadow SIEMPRE
        // usa 'baileys-shadow', sin importar esta variable, ver
        // messaging/index.js y messaging/adapters/baileys.js).
        WHATSAPP_BAILEYS_AUTH_DIR: env.WHATSAPP_BAILEYS_AUTH_DIR || '',
        // Fase A5 — piloto de Baileys: si es "true" y WHATSAPP_GROUP_ID_TEST
        // está definido, ESE grupo de prueba se mapea a formato '2v2' en vez
        // de WHATSAPP_GROUP_ID (pensado para un contenedor piloto aparte con
        // su propio volumen de auth/output, ver docs/baileys-migration.md).
        WHATSAPP_PILOT: env.WHATSAPP_PILOT === 'true',
        WHATSAPP_GROUP_ID_TEST: env.WHATSAPP_GROUP_ID_TEST || '',
        // Ventana de vigencia de un comando entrante (segundos). Un mensaje
        // más viejo se ignora sin correr el handler: evita que el historial
        // reproducido tras una reconexión dispare un "!rondas reset" viejo.
        COMMAND_MAX_AGE_S: Number(env.COMMAND_MAX_AGE_S) > 0 ? Number(env.COMMAND_MAX_AGE_S) : 120,
        LEADERBOARD_MIN_GAMES: env.LEADERBOARD_MIN_GAMES,
        CORS_ORIGIN: env.CORS_ORIGIN,
        BACKUP_INCLUDE_AUTH: env.BACKUP_INCLUDE_AUTH === 'true',
        // Fase B3 — identidad de instalación (server/http/routes/report.js):
        // instalaciones puntuales que se quieren cortar (reportes corruptos,
        // copia mal configurada) sin tocar la API key compartida por todos.
        REVOKED_INSTALL_IDS: (env.REVOKED_INSTALL_IDS || '')
            .split(',').map(s => s.trim()).filter(Boolean),
        // Versión mínima de cliente aceptada (semver "x.y.z"); sin configurar,
        // no se rechaza ningún cliente por versión.
        CLIENT_MIN_VERSION: env.CLIENT_MIN_VERSION || null,
        // Fase A4 — "guardar primero + outbox persistente" (server/messaging/
        // outboxStore.js, outbox.js). Apagado por default: la tabla `outbox`
        // se aplica A MANO (ver supabase_schema.sql, bloque "migración A4")
        // y el código debe seguir funcionando si todavía no existe.
        OUTBOX_ENABLED: env.OUTBOX_ENABLED === 'true',
        // Intervalo (ms) del polling del worker de outbox.
        OUTBOX_POLL_MS: Number(env.OUTBOX_POLL_MS) > 0 ? Number(env.OUTBOX_POLL_MS) : 5000,
        // Intentos antes de marcar una fila como 'dead' (backoff exponencial
        // 5s·2^intentos, tope 15 min).
        OUTBOX_MAX_ATTEMPTS: Number(env.OUTBOX_MAX_ATTEMPTS) > 0 ? Number(env.OUTBOX_MAX_ATTEMPTS) : 8,
    });
}

module.exports = { loadConfig };
