/**
 * Tests de server/http/errors.js (Fase A1) con una app Express desechable
 * (index.js no se puede requerir sin arrancar el servidor completo — ver
 * comentario en la Fase A1 del roadmap): HttpError con status a medida,
 * asyncHandler atrapando rechazos, el 404 JSON de /api/* sin ruta, y que un
 * 500 nunca filtre el mensaje interno del error.
 */

const { test } = require('node:test');
const assert = require('assert');
const express = require('express');
const http = require('http');

const { HttpError, notFound, errorHandler, asyncHandler } = require('./errors');

/** Levanta una app desechable en un puerto efímero y la cierra al terminar. */
async function withApp(buildApp, fn) {
    const app = buildApp();
    const server = await new Promise((resolve) => {
        const s = app.listen(0, () => resolve(s));
    });
    try {
        const { port } = server.address();
        await fn(`http://127.0.0.1:${port}`);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
}

async function getJson(url) {
    return new Promise((resolve, reject) => {
        http.get(url, (res) => {
            let raw = '';
            res.on('data', (chunk) => { raw += chunk; });
            res.on('end', () => {
                try {
                    resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null });
                } catch (err) {
                    reject(err);
                }
            });
        }).on('error', reject);
    });
}

function buildTestApp() {
    const app = express();

    app.get('/api/boom-sync', () => {
        throw new Error('mensaje interno sensible, no debe salir al cliente');
    });

    app.get('/api/boom-async', asyncHandler(async () => {
        throw new Error('rechazo async también debe llegar al errorHandler');
    }));

    app.get('/api/http-error', asyncHandler(async () => {
        throw new HttpError(409, 'conflicto declarado a propósito', { candidates: ['a', 'b'] });
    }));

    app.get('/api/ok', asyncHandler(async (req, res) => {
        res.json({ status: 'ok' });
    }));

    app.use('/api', notFound);
    app.use(errorHandler);
    return app;
}

test('asyncHandler: una ruta que resuelve normal no se ve afectada', async () => {
    await withApp(buildTestApp, async (base) => {
        const { status, body } = await getJson(`${base}/api/ok`);
        assert.strictEqual(status, 200);
        assert.deepStrictEqual(body, { status: 'ok' });
    });
});

test('notFound: /api/* sin ruta -> 404 JSON con el path pedido', async () => {
    await withApp(buildTestApp, async (base) => {
        const { status, body } = await getJson(`${base}/api/no-existe`);
        assert.strictEqual(status, 404);
        assert.strictEqual(body.error, 'No encontrado');
        assert.strictEqual(body.path, '/api/no-existe');
    });
});

test('errorHandler: excepción síncrona en la ruta -> 500 genérico, sin filtrar el mensaje interno', async () => {
    await withApp(buildTestApp, async (base) => {
        const { status, body } = await getJson(`${base}/api/boom-sync`);
        assert.strictEqual(status, 500);
        assert.strictEqual(body.error, 'Error interno del servidor');
        assert.ok(!JSON.stringify(body).includes('mensaje interno sensible'));
    });
});

test('asyncHandler + errorHandler: rechazo de una promesa también llega al 500 genérico', async () => {
    await withApp(buildTestApp, async (base) => {
        const { status, body } = await getJson(`${base}/api/boom-async`);
        assert.strictEqual(status, 500);
        assert.strictEqual(body.error, 'Error interno del servidor');
    });
});

test('HttpError: respeta el status y agrega los campos extra a la respuesta', async () => {
    await withApp(buildTestApp, async (base) => {
        const { status, body } = await getJson(`${base}/api/http-error`);
        assert.strictEqual(status, 409);
        assert.strictEqual(body.error, 'conflicto declarado a propósito');
        assert.deepStrictEqual(body.candidates, ['a', 'b']);
    });
});
