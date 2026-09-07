/**
 * Construcción de la app de Express (Fase A2 — partir index.js).
 *
 * `createApp(deps)` NO escucha (`app.listen`) ni inicializa WhatsApp: solo
 * arma middleware + rutas, para poder instanciarla en tests con dependencias
 * falsas (ver server/test/app.test.js). server/index.js es quien hace
 * `createApp(ctx).listen(...)`.
 *
 * Mismo orden de middleware/rutas que el index.js monolítico:
 *  1. seguridad (helmet, json body, cors, pino-http en /api)
 *  2. estáticos del dashboard
 *  3. /api/health, /api/status
 *  4. /api/report
 *  5. rate limiters de /api/admin y /api/stats + rutas admin/stats
 *  6. /api/stripe/create-payment-intent
 *  7. 404 JSON de /api/*, catch-all SPA, errorHandler
 */

'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const helmet = require('helmet');
const pinoHttp = require('pino-http');

const { notFound, errorHandler } = require('./http/errors');
const { adminLimiter, publicLimiter } = require('./http/limiters');
const { createHealthRouter } = require('./http/routes/health');
const { createReportRouter } = require('./http/routes/report');
const { createAdminGamesRouter } = require('./http/routes/adminGames');
const { createAdminWhatsappRouter } = require('./http/routes/adminWhatsapp');
const { createStatsRouter } = require('./http/routes/stats');
const { createStripeRouter } = require('./http/routes/stripe');

const DASHBOARD_DIST = path.join(__dirname, '../dashboard/dist');

/**
 * @param {object} ctx - contexto compartido: { config, logger, supabase,
 *   whatsapp, discord, discord4v4, renderer, alerts, outputDir, gamesCache,
 *   locks, version, getSchedulerJobs }
 * @returns {import('express').Express}
 */
function createApp(ctx) {
    const log = ctx.logger.child({ mod: 'http' });
    const app = express();

    // Detrás de Caddy (proxy reverso): confiar en 1 hop para que el rate-limit
    // y los logs usen la IP real del cliente, no la del proxy.
    app.set('trust proxy', 1);

    // Headers de seguridad. CSP desactivado a propósito: el servidor sirve el
    // dashboard (Vite) y el modal de Stripe carga js.stripe.com; una CSP estricta
    // los rompería. Se conservan noSniff, frameguard, referrer-policy, etc.
    app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));

    // Un reporte 2v2 es pequeño; 256kb es más que suficiente y acota abuso.
    app.use(express.json({ limit: '256kb' }));

    // El dashboard se sirve desde el MISMO origen (estático, más abajo), así que
    // no necesita CORS. CORS_ORIGIN queda como escape hatch para un frontend en
    // otro dominio (ver .env.example); sin configurar, `false` desactiva los
    // headers de CORS por completo (antes era cors() abierto a cualquier origen).
    app.use(cors({ origin: ctx.config.CORS_ORIGIN ? ctx.config.CORS_ORIGIN.split(',') : false }));

    // Logs estructurados de cada request /api/* (Fase A1). Montado en /api para
    // no ensuciar los logs con las peticiones de archivos estáticos del
    // dashboard (JS/CSS/imágenes) ni el catch-all del SPA. /api/health se
    // excluye del auto-log: el healthcheck de Docker le pega cada 30s y no
    // aporta nada ver esa línea una y otra vez.
    app.use('/api', pinoHttp({
        logger: log,
        autoLogging: {
            ignore: (req) => req.originalUrl === '/api/health',
        },
    }));

    // Servir archivos estáticos del dashboard (Frontend)
    if (fs.existsSync(DASHBOARD_DIST)) {
        app.use(express.static(DASHBOARD_DIST));
        log.info(`🌐 Dashboard frontend listo en: ${DASHBOARD_DIST}`);
    }

    // ============== ENDPOINTS ==============

    app.use(createHealthRouter(ctx));
    app.use(createReportRouter(ctx));

    // ============== ADMIN ENDPOINTS ==============

    // Todos los endpoints admin pasan por el rate limiter (freno a fuerza bruta)
    app.use('/api/admin', adminLimiter);
    // Endpoints públicos de lectura (dashboard)
    app.use('/api/stats', publicLimiter);

    app.use(createAdminGamesRouter(ctx));
    app.use(createAdminWhatsappRouter(ctx));

    // ============== DASHBOARD STATS ENDPOINTS ==============

    app.use(createStatsRouter(ctx));

    // ============== STRIPE PAYMENT ENDPOINTS ==============

    app.use(createStripeRouter(ctx));

    // ============== FIN DE RUTAS ==============

    // /api/* que no matcheó ninguna ruta anterior -> 404 JSON, no el index.html
    // del SPA. Debe ir DESPUÉS de todas las rutas /api/* de arriba y ANTES del
    // catch-all del SPA de abajo.
    app.use('/api', notFound);

    // Servir index.html para cualquier otra ruta (SPA)
    app.get('*', (req, res) => {
        const indexPath = path.join(DASHBOARD_DIST, 'index.html');
        if (fs.existsSync(indexPath)) {
            res.sendFile(indexPath);
        } else {
            res.status(404).send('Dashboard not built');
        }
    });

    // Manejador de errores de Express: SIEMPRE al final de todo el stack.
    app.use(errorHandler);

    return app;
}

module.exports = { createApp, DASHBOARD_DIST };
