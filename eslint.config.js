'use strict';

/**
 * Config plana de ESLint para el monorepo (Fase A0 — red de seguridad).
 *
 * Cubre server/, client/, tests/ y scripts/ (Node/CommonJS). El dashboard
 * tiene su propio eslint.config.js (React/browser) y se ignora aquí.
 * scripts/legacy/ también se ignora: son scripts sueltos sin mantenimiento
 * (ver scripts/legacy/README.md), no vale la pena pulir código muerto.
 */

const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
    {
        ignores: [
            '**/node_modules/**',
            'dashboard/**',
            '**/dist/**',
            'server/output/**',
            'scripts/legacy/**',
        ],
    },
    {
        files: ['server/**/*.js', 'client/**/*.js', 'tests/**/*.js', 'scripts/**/*.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'commonjs',
            globals: {
                ...globals.node,
            },
        },
        rules: {
            ...js.configs.recommended.rules,
            eqeqeq: ['error', 'smart'],
            'no-unused-vars': ['error', { args: 'after-used', argsIgnorePattern: '^_' }],
        },
    },
    {
        // Fase A1 — observabilidad: el código que corre en el servidor (app,
        // servicios, jobs, el store de estado) debe loggear con
        // server/logger.js (pino), no con console.*, para que todo salga como
        // JSON estructurado en docker logs. server/logger.js es la única
        // excepción (es quien envuelve a pino). El bloque que imprime el QR de
        // WhatsApp en services/whatsapp.js usa eslint-disable-next-line
        // puntual: ese dibujo ASCII debe llegar a la terminal tal cual, no
        // envuelto en JSON.
        //
        // Se excluyen los tests (console.log de depuración es una práctica ya
        // establecida en este repo, ver server/test/*.test.js) y reset_db.js
        // (script manual de un solo uso para consola interactiva, no corre
        // dentro del servidor).
        files: ['server/**/*.js'],
        ignores: ['server/logger.js', 'server/test/**', 'server/reset_db.js'],
        rules: {
            'no-console': 'error',
        },
    },
];
