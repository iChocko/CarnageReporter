/**
 * Rate limiting (Fase A2 — movido tal cual desde index.js).
 */

'use strict';

const rateLimit = require('express-rate-limit');

const reportLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 60, // 60 reportes por IP cada 15 min
    standardHeaders: true, legacyHeaders: false,
    message: { error: 'Demasiados reportes; intenta más tarde.' }
});
const adminLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20, // 20 intentos admin por IP cada 15 min (freno a fuerza bruta)
    standardHeaders: true, legacyHeaders: false,
    // Solo cuenta intentos FALLIDOS: necesario para la futura página web de
    // admin, donde una sesión legítima hace muchas llamadas exitosas
    // seguidas y no debe toparse con el límite pensado para fuerza bruta.
    skipSuccessfulRequests: true,
    message: { error: 'Demasiados intentos.' }
});
const publicLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 120, // 120 lecturas por IP por minuto (dashboard)
    standardHeaders: true, legacyHeaders: false
});

module.exports = { reportLimiter, adminLimiter, publicLimiter };
