/**
 * Fábrica del MessagingPort activo (Fase A3), elegido por
 * `WHATSAPP_TRANSPORT`:
 *
 *   - 'wwebjs' (default, producción) -> adapters/wwebjs.js
 *   - 'fake'   (tests)               -> adapters/fake.js
 *   - 'baileys'                      -> todavía no existe (Fase A5)
 *
 * `WHATSAPP_SHADOW_TRANSPORT`, si se define, corre un segundo transporte EN
 * PARALELO y en modo solo-lectura (adapters/shadow.js) — pensado para
 * probar un transporte nuevo contra tráfico real sin arriesgar un envío
 * doble. Hoy solo se acepta 'fake' (un transporte de verdad en shadow, como
 * Baileys, llega en una fase futura).
 */

'use strict';

const { createFakePort } = require('./adapters/fake');
const { createShadowPort } = require('./adapters/shadow');

function buildPort(transport, deps) {
    switch (transport) {
        case 'wwebjs': {
            const WwebjsPort = require('./adapters/wwebjs');
            return new WwebjsPort();
        }
        case 'fake':
            return createFakePort(deps.fake);
        case 'baileys':
            throw new Error('WHATSAPP_TRANSPORT=baileys: not implemented yet (Phase A5)');
        default:
            throw new Error(`WHATSAPP_TRANSPORT="${transport}" desconocido (usa 'wwebjs', 'fake' o 'baileys')`);
    }
}

/**
 * @param {{WHATSAPP_TRANSPORT?: string, WHATSAPP_SHADOW_TRANSPORT?: string}} [config]
 * @param {{fake?: object, logger?: object}} [deps] - opciones para el transporte fake y logger del shadow
 * @returns {import('./port').MessagingPort} el puerto primario; si hay shadow
 *   configurado, queda expuesto (no forma parte del contrato) en `.shadow`.
 */
function createMessagingPort(config = {}, deps = {}) {
    const transport = config.WHATSAPP_TRANSPORT || 'wwebjs';
    const port = buildPort(transport, deps);

    const shadowTransport = config.WHATSAPP_SHADOW_TRANSPORT;
    if (shadowTransport) {
        if (shadowTransport !== 'fake') {
            throw new Error(`WHATSAPP_SHADOW_TRANSPORT="${shadowTransport}" no soportado todavía (solo "fake")`);
        }
        port.shadow = createShadowPort(createFakePort(deps.fake), { logger: deps.logger });
    }

    return port;
}

module.exports = { createMessagingPort };
