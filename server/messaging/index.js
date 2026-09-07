/**
 * Fábrica del MessagingPort activo (Fase A3, Baileys en Fase A5), elegido por
 * `WHATSAPP_TRANSPORT`:
 *
 *   - 'wwebjs'  (default, producción) -> adapters/wwebjs.js
 *   - 'fake'    (tests)               -> adapters/fake.js
 *   - 'baileys' (Fase A5)             -> adapters/baileys.js
 *
 * `WHATSAPP_SHADOW_TRANSPORT`, si se define, corre un segundo transporte EN
 * PARALELO y en modo solo-lectura (adapters/shadow.js) — pensado para
 * probar un transporte nuevo contra tráfico real sin arriesgar un envío
 * doble. Acepta 'fake' o 'baileys' (Fase A5); cuando es 'baileys' usa su
 * propia subcarpeta de auth ('baileys-shadow', ver adapters/baileys.js) para
 * no compartir sesión con la instancia primaria.
 *
 * El shadow siempre recibe una referencia al puerto primario, así que además
 * compara (`shadow.compare`, ver adapters/shadow.js) sus mensajes contra los
 * que ya vio/despachó el primario — la validación real de la Fase A5 (¿el
 * transporte nuevo, típicamente 'baileys' en shadow de un primario 'wwebjs',
 * ve lo mismo que el viejo?). La comparación es transporte-neutral (compara
 * sobre `IncomingMessage`, no sobre nada específico de Baileys).
 *
 * Fase A5 — piloto: `WHATSAPP_PILOT=true` + `WHATSAPP_GROUP_ID_TEST` mapea
 * ESE grupo de prueba a formato '2v2' (en vez de WHATSAPP_GROUP_ID), pensado
 * para un contenedor piloto aparte con su propio volumen de auth/output (ver
 * docs/baileys-migration.md) — nunca para el proceso de producción normal.
 */

'use strict';

const { createFakePort } = require('./adapters/fake');
const { createShadowPort } = require('./adapters/shadow');

/** Mapeo de grupos 2v2/4v4 desde env, con el desvío del piloto (Fase A5). */
function groupConfigFromEnv(config) {
    const pilot = config.WHATSAPP_PILOT === true || config.WHATSAPP_PILOT === 'true';
    const groupId2v2 = (pilot && config.WHATSAPP_GROUP_ID_TEST)
        ? config.WHATSAPP_GROUP_ID_TEST
        : (config.WHATSAPP_GROUP_ID || process.env.WHATSAPP_GROUP_ID || null);
    return {
        '2v2': { id: groupId2v2 || null, name: config.WHATSAPP_GROUP_NAME || process.env.WHATSAPP_GROUP_NAME || null },
        '4v4': {
            id: config.WHATSAPP_GROUP_ID_4V4 || process.env.WHATSAPP_GROUP_ID_4V4 || null,
            name: config.WHATSAPP_GROUP_NAME_4V4 || process.env.WHATSAPP_GROUP_NAME_4V4 || null,
        },
    };
}

function buildPort(transport, config, deps, { authSubdir } = {}) {
    switch (transport) {
        case 'wwebjs': {
            const WwebjsPort = require('./adapters/wwebjs');
            return new WwebjsPort();
        }
        case 'fake':
            return createFakePort(deps.fake);
        case 'baileys': {
            const BaileysPort = require('./adapters/baileys');
            return new BaileysPort({
                groupConfig: groupConfigFromEnv(config),
                commandMaxAgeSec: config.COMMAND_MAX_AGE_S,
                ...(authSubdir ? { authSubdir } : {}),
                ...(deps.baileys || {}),
            });
        }
        default:
            throw new Error(`WHATSAPP_TRANSPORT="${transport}" desconocido (usa 'wwebjs', 'fake' o 'baileys')`);
    }
}

/**
 * @param {{WHATSAPP_TRANSPORT?: string, WHATSAPP_SHADOW_TRANSPORT?: string}} [config]
 * @param {{fake?: object, baileys?: object, logger?: object}} [deps] -
 *   opciones para el transporte fake, opciones extra para el/los Baileys
 *   (p.ej. socketFactory/authStateFactory/fetchVersion en tests), y logger
 *   del shadow.
 * @returns {import('./port').MessagingPort} el puerto primario; si hay shadow
 *   configurado, queda expuesto (no forma parte del contrato) en `.shadow`.
 */
function createMessagingPort(config = {}, deps = {}) {
    const transport = config.WHATSAPP_TRANSPORT || 'wwebjs';
    const port = buildPort(transport, config, deps);

    const shadowTransport = config.WHATSAPP_SHADOW_TRANSPORT;
    if (shadowTransport) {
        let shadowInner;
        if (shadowTransport === 'fake') {
            shadowInner = createFakePort(deps.fake);
        } else if (shadowTransport === 'baileys') {
            shadowInner = buildPort('baileys', config, deps, { authSubdir: 'baileys-shadow' });
        } else {
            throw new Error(`WHATSAPP_SHADOW_TRANSPORT="${shadowTransport}" no soportado (usa 'fake' o 'baileys')`);
        }
        // Se pasa siempre el primario para que el shadow loggee `shadow.compare`
        // (ver adapters/shadow.js) — es el caso de uso real de la Fase A5:
        // primario 'wwebjs' de producción + shadow 'baileys' bajo prueba.
        port.shadow = createShadowPort(shadowInner, { logger: deps.logger, primary: port });
    }

    return port;
}

module.exports = { createMessagingPort };
