/**
 * Logger centralizado (Fase A1 — observabilidad).
 *
 * JSON estructurado a stdout (pino), nivel configurable por LOG_LEVEL
 * (default 'info'). En docker logs se ve como JSON por línea; en desarrollo
 * se puede canalizar a pino-pretty (ver `npm run dev`).
 *
 * Los módulos del servidor NO deben usar console.* directamente (ESLint
 * no-console lo marca como error en server/**): usan child(bindings) para
 * obtener un logger con un campo `mod` fijo, p.ej.:
 *   const log = require('../logger').child({ mod: 'whatsapp' });
 *   log.info('mensaje');
 *   log.error({ err }, 'algo falló');
 *
 * Excepciones deliberadas a no-console (ver eslint.config.js):
 *  - este archivo (necesita usar pino directamente).
 *  - el bloque que imprime el QR de WhatsApp con qrcode-terminal: ese
 *    dibujo ASCII debe llegar a `docker logs` tal cual, sin envolverlo en
 *    JSON (dejaría de ser escaneable a simple vista).
 */

'use strict';

const pino = require('pino');

const logger = pino({
    level: process.env.LOG_LEVEL || 'info',
});

/**
 * Logger hijo con bindings fijos (normalmente { mod: '<nombre-del-módulo>' }),
 * para que cada línea de log diga de qué parte del servidor viene.
 * @param {object} bindings
 * @returns {import('pino').Logger}
 */
function child(bindings) {
    return logger.child(bindings);
}

module.exports = { logger, child };
