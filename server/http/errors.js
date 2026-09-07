/**
 * Manejo centralizado de errores HTTP (Fase A1 — observabilidad).
 *
 * Antes cada ruta tenía su propio `catch (error) { console.error(...); res
 * .status(500).json({ error: 'Error interno del servidor' }) }` copiado
 * ~20 veces. Ahora las rutas async se envuelven con `asyncHandler` (Express
 * 4 no atrapa rechazos de promesas por sí solo) y delegan el error a
 * `next(error)`; este archivo lo loggea una sola vez y arma la respuesta.
 *
 * Contrato:
 *  - `notFound` se monta en `app.use('/api', notFound)` DESPUÉS de todas las
 *    rutas /api/* y ANTES del catch-all del SPA, para que un endpoint /api
 *    inexistente responda 404 JSON en vez del index.html del dashboard.
 *  - `errorHandler` se monta al final de todo el stack de middlewares.
 *  - Un error con `.status` numérico (p.ej. HttpError, o cualquier error de
 *    librería que ya traiga esa propiedad) respeta ese código; si no, 500.
 *  - El cuerpo de la respuesta NUNCA expone el mensaje interno en un 500
 *    (podría filtrar detalles de Supabase/WhatsApp/etc.); los códigos 4xx sí
 *    devuelven `err.message` porque son mensajes pensados para el cliente.
 */

'use strict';

const { logger } = require('../logger');

const log = logger.child({ mod: 'http' });

/** Error HTTP con status y datos extra opcionales para la respuesta JSON. */
class HttpError extends Error {
    constructor(status, message, extra) {
        super(message);
        this.name = 'HttpError';
        this.status = status;
        this.extra = extra;
    }
}

/**
 * Envuelve un handler async para que sus rechazos lleguen a next(error) en
 * vez de tumbar el proceso (Express 4 no hace esto automáticamente).
 * @param {(req: import('express').Request, res: import('express').Response, next: import('express').NextFunction) => Promise<any>} fn
 */
function asyncHandler(fn) {
    return function wrapped(req, res, next) {
        Promise.resolve(fn(req, res, next)).catch(next);
    };
}

/** 404 JSON para cualquier /api/* que no matcheó ninguna ruta anterior. */
function notFound(req, res) {
    res.status(404).json({ error: 'No encontrado', path: req.originalUrl });
}

/** Middleware de error de Express (4 argumentos = firma especial, obligatoria). */
function errorHandler(err, req, res, _next) {
    const status = Number.isInteger(err?.status) ? err.status : 500;
    const logCtx = {
        reqId: req.id,
        method: req.method,
        url: req.originalUrl,
        status,
    };

    if (status >= 500) {
        log.error({ ...logCtx, stack: err?.stack }, err?.message || 'Error interno del servidor');
    } else {
        log.warn(logCtx, err?.message || 'Error de cliente');
    }

    const body = { error: status >= 500 ? 'Error interno del servidor' : (err?.message || 'Error') };
    if (err?.extra && typeof err.extra === 'object') Object.assign(body, err.extra);
    res.status(status).json(body);
}

module.exports = { HttpError, notFound, errorHandler, asyncHandler };
