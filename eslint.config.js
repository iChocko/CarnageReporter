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
];
