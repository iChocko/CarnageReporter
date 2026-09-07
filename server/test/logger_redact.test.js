/**
 * El logger raíz NUNCA debe dejar la API key del cliente ni la admin key en
 * los logs (pino-http serializa req.headers completo si no se le limita).
 */

const { test } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const pino = require('pino');

test('la config de redact del logger raíz cubre x-api-key, x-admin-key, authorization y cookie', () => {
    const src = fs.readFileSync(require.resolve('../logger'), 'utf-8');
    for (const p of ['x-api-key', 'x-admin-key', 'authorization', 'cookie']) {
        assert.ok(src.includes(p), `falta ${p} en REDACT_PATHS`);
    }
    assert.ok(src.includes('redact:'), 'el logger raíz no configura redact');
});

test('un logger con esos paths de redact censura los headers sensibles y conserva el resto', () => {
    const chunks = [];
    const log = pino({
        level: 'info',
        redact: {
            paths: ['req.headers["x-api-key"]', 'req.headers["x-admin-key"]', 'req.headers.authorization'],
            censor: '[redactado]',
        },
    }, { write: (s) => chunks.push(s) });

    log.info({ req: { headers: { 'x-api-key': 'SECRETO1', 'x-admin-key': 'SECRETO2', authorization: 'Bearer S3', 'user-agent': 'ua' } } }, 'req');

    const out = chunks.join('');
    assert.ok(!out.includes('SECRETO1') && !out.includes('SECRETO2') && !out.includes('Bearer S3'), out);
    assert.ok(out.includes('[redactado]'), out);
    assert.ok(out.includes('"user-agent":"ua"'), out);
});
