#!/usr/bin/env node
/**
 * Inventario de rutas registradas por createApp (Fase A2).
 *
 * Construye la app con dependencias falsas (nada toca red/disco real) y
 * imprime "MÉTODO /ruta" de cada endpoint registrado, ordenado. Se usó para
 * comparar 1:1 contra las rutas del index.js monolítico antes de la Fase A2
 * (`grep -oE "app\\.(get|post|delete)\\('[^']+'" server/index.js`) y sirve
 * como red de seguridad para futuras reorganizaciones de rutas.
 *
 * Uso: node server/scripts/route-inventory.js
 */

'use strict';

const os = require('os');
const { createApp } = require('../app');
const { logger } = require('../logger');

/** Dependencias falsas mínimas: nada se invoca al solo registrar rutas. */
function buildStubCtx() {
    return {
        config: {
            API_KEY: 'stub-api-key',
            ADMIN_KEY: 'stub-admin-key',
            STRIPE_SECRET_KEY: null,
            CORS_ORIGIN: null,
            LEADERBOARD_MIN_GAMES: '5',
            WHATSAPP_ADMIN_JIDS: '',
        },
        logger,
        supabase: {},
        whatsapp: {},
        discord: {},
        discord4v4: {},
        renderer: {},
        alerts: { alert: async () => false },
        outputDir: os.tmpdir(),
        gamesCache: {},
        locks: {},
        version: 'stub',
        getSchedulerJobs: () => [],
    };
}

/** Recorre app._router.stack y devuelve ["MÉTODO /ruta", ...] sin duplicados, ordenado. */
function listRoutes(app) {
    const routes = new Set();

    function walk(stack) {
        for (const layer of stack) {
            if (layer.route) {
                const methods = Object.keys(layer.route.methods).filter(m => layer.route.methods[m]);
                for (const method of methods) {
                    routes.add(`${method.toUpperCase()} ${layer.route.path}`);
                }
            } else if (layer.name === 'router' && layer.handle && layer.handle.stack) {
                walk(layer.handle.stack);
            }
        }
    }

    walk(app._router.stack);
    return [...routes].sort();
}

if (require.main === module) {
    const app = createApp(buildStubCtx());
    for (const route of listRoutes(app)) {
        // eslint-disable-next-line no-console -- script manual de consola, ver eslint.config.js
        console.log(route);
    }
}

module.exports = { listRoutes, buildStubCtx };
