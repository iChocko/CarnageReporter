/**
 * Regresión de prod (2026-09-07): GET /api/admin/whatsapp/qr?transport=shadow
 * tronaba con "port.getQR is not a function" porque el ShadowPort no exponía
 * el shim legacy getQR(); debe delegar al inner o derivarlo de getPairing().
 */

const { test } = require('node:test');
const assert = require('assert');

const { createFakePort } = require('../../messaging/adapters/fake');
const { createShadowPort } = require('../../messaging/adapters/shadow');

test('ShadowPort.getQR() usa getQR() del inner si existe', () => {
    const inner = createFakePort();
    inner.getQR = () => 'QR-INNER';
    const shadow = createShadowPort(inner, { primary: createFakePort() });
    assert.strictEqual(shadow.getQR(), 'QR-INNER');
});

test('ShadowPort.getQR() cae a getPairing().qr cuando el inner no tiene getQR()', () => {
    const inner = createFakePort();
    delete inner.getQR;
    inner.getPairing = () => ({ qr: 'QR-PAIRING' });
    const shadow = createShadowPort(inner, { primary: createFakePort() });
    assert.strictEqual(shadow.getQR(), 'QR-PAIRING');
});

test('ShadowPort.getQR() devuelve null sin QR pendiente', () => {
    const inner = createFakePort();
    delete inner.getQR;
    inner.getPairing = () => null;
    const shadow = createShadowPort(inner, { primary: createFakePort() });
    assert.strictEqual(shadow.getQR(), null);
});
