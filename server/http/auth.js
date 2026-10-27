/**
 * Autenticación HTTP (Fase A2 — movido tal cual desde index.js).
 *
 * `safeEqual` compara secretos en tiempo constante; `authMiddleware` y
 * `adminAuthMiddleware` son fábricas que toman la config ya cargada
 * (server/config.js) en vez de leer process.env directamente, para poder
 * inyectar claves falsas en tests sin tocar variables de entorno globales.
 */

'use strict';

const crypto = require('crypto');

/**
 * Comparación de secretos en tiempo constante (evita distinguir claves por
 * timing). Ambos lados se hashean a longitud fija antes de comparar para no
 * filtrar la longitud del secreto.
 */
function safeEqual(a, b) {
    const ha = crypto.createHash('sha256').update(String(a || '')).digest();
    const hb = crypto.createHash('sha256').update(String(b || '')).digest();
    return crypto.timingSafeEqual(ha, hb);
}

/** Middleware de autenticación de clientes (X-API-Key). */
function authMiddleware(config) {
    return function authMiddlewareHandler(req, res, next) {
        if (!safeEqual(req.headers['x-api-key'], config.API_KEY)) {
            return res.status(401).json({ error: 'API key inválida' });
        }
        next();
    };
}

/**
 * Middleware de administración: requiere header X-Admin-Key.
 * Si ADMIN_KEY no está configurada, los endpoints admin quedan deshabilitados (503).
 */
function adminAuthMiddleware(config) {
    return function adminAuthMiddlewareHandler(req, res, next) {
        if (!config.ADMIN_KEY) {
            return res.status(503).json({ error: 'Endpoints admin deshabilitados (ADMIN_KEY no configurada)' });
        }
        if (!safeEqual(req.headers['x-admin-key'], config.ADMIN_KEY)) {
            return res.status(401).json({ error: 'Admin key inválida' });
        }
        next();
    };
}

/**
 * Middleware del panel del torneo: acepta ADMIN_KEY (rol 'admin') o
 * TORNEO_ADMIN_KEY (rol 'torneo'). Deja el rol en `req.adminRole`.
 */
function torneoAdminAuthMiddleware(config) {
    return function torneoAdminAuthMiddlewareHandler(req, res, next) {
        if (!config.ADMIN_KEY && !config.TORNEO_ADMIN_KEY) {
            return res.status(503).json({ error: 'Endpoints admin deshabilitados (sin ADMIN_KEY ni TORNEO_ADMIN_KEY)' });
        }
        const key = req.headers['x-admin-key'];
        if (config.ADMIN_KEY && safeEqual(key, config.ADMIN_KEY)) {
            req.adminRole = 'admin';
            return next();
        }
        if (config.TORNEO_ADMIN_KEY && safeEqual(key, config.TORNEO_ADMIN_KEY)) {
            req.adminRole = 'torneo';
            return next();
        }
        return res.status(401).json({ error: 'Admin key inválida' });
    };
}

module.exports = { safeEqual, authMiddleware, adminAuthMiddleware, torneoAdminAuthMiddleware };
