/**
 * Cache de accesos individuales (domain/torneoAccesos.js).
 */

const { test } = require('node:test');
const assert = require('assert');
const { createAccesoLookup } = require('../domain/torneoAccesos');
const { hashKey } = require('../http/auth');

test('busca por sha256, cachea (también rechazos) y respeta el TTL', async () => {
    let t = 0;
    const calls = [];
    let activo = true;
    const supabase = {
        async getTorneoAcceso(hash) {
            calls.push(hash);
            return activo && hash === hashKey('clave-tomm') ? { id: 7, nombre: 'Tomm' } : null;
        },
        touches: 0,
        async touchTorneoAcceso() { this.touches++; },
    };
    const lookup = createAccesoLookup(supabase, { ttlMs: 1000, now: () => t });

    assert.deepStrictEqual(await lookup('clave-tomm'), { id: 7, nombre: 'Tomm' });
    assert.deepStrictEqual(await lookup('clave-tomm'), { id: 7, nombre: 'Tomm' });
    assert.strictEqual(await lookup('otra'), null);
    assert.strictEqual(await lookup('otra'), null);
    assert.strictEqual(calls.length, 2);
    assert.strictEqual(supabase.touches, 1);

    // Revocado en Supabase: se nota al vencer el TTL
    activo = false;
    t = 1500;
    assert.strictEqual(await lookup('clave-tomm'), null);
});

test('sin soporte en Supabase (tabla/método ausente) nadie entra con clave de organizador', async () => {
    const lookup = createAccesoLookup({});
    assert.strictEqual(await lookup('lo-que-sea'), null);
});
