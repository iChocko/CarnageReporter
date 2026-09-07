/**
 * Corre el contrato de MessagingPort (port.contract.js) contra el FakePort,
 * y unos tests propios de FakePort que no son parte del contrato genérico.
 *
 * También deja el enganche para correrlo contra el adaptador REAL de
 * wwebjs, pero SOLO si WA_CONTRACT=1 está en el ambiente — eso requiere una
 * sesión de WhatsApp real (Chromium + LocalAuth), así que nunca corre en CI
 * ni en `npm test` normal. Ver el reporte de la Fase A3 para las
 * excepciones documentadas del adaptador de wwebjs al contrato estricto
 * (getStatus()/sendImage() conservan su forma heredada por compatibilidad;
 * getPortStatus() es la forma de contrato completa).
 */

'use strict';

const { test } = require('node:test');
const assert = require('assert');

const { createFakePort } = require('../../messaging/adapters/fake');
const { runPortContract } = require('./port.contract');

console.log('\n— MessagingPort contract (FakePort) —');
runPortContract(() => createFakePort({ groups: { '2v2': { id: 'g2v2@g.us', name: 'Retas H3' } } }));

if (process.env.WA_CONTRACT === '1') {
    const WwebjsPort = require('../../messaging/adapters/wwebjs');
    console.log('\n— MessagingPort contract (wwebjs, WA_CONTRACT=1) —');
    runPortContract(() => new WwebjsPort(), { skipSend: true });
}

console.log('\n— FakePort: helpers propios (no forman parte del contrato) —');

test('emitIncoming resuelve el formato a partir del chatId configurado', async () => {
    const port = createFakePort({ groups: { '2v2': { id: 'g2v2@g.us' }, '4v4': { id: 'g4v4@g.us' } } });
    await port.start();
    const msg = port.emitIncoming({ chatId: 'g4v4@g.us', text: '!partidas' });
    assert.strictEqual(msg.format, '4v4');
});

test('sendText en modo solo-lectura lanza SendError("read_only")', async () => {
    const { SendError } = require('../../messaging/port');
    const port = createFakePort({ groups: { '2v2': { id: 'g2v2@g.us' } } });
    await port.start();
    port.setReadOnly(true);
    await assert.rejects(() => port.sendText('g2v2@g.us', 'hola'), err => err instanceof SendError && err.code === 'read_only');
});

test('sendImage resuelve {id} y queda registrado en sent', async () => {
    const port = createFakePort({ groups: { '2v2': { id: 'g2v2@g.us' } } });
    await port.start();
    const result = await port.sendImage('g2v2@g.us', { path: '/tmp/x.png', caption: 'hola' });
    assert.strictEqual(typeof result.id, 'string');
    assert.strictEqual(port.sent[0].kind, 'image');
    assert.strictEqual(port.sent[0].caption, 'hola');
});

test('requestPairingCode emite "pairing" y queda disponible en getPairing()', async () => {
    const port = createFakePort();
    const seen = [];
    port.on('pairing', p => seen.push(p));
    const code = await port.requestPairingCode('5215551234567');
    assert.strictEqual(typeof code, 'string');
    assert.strictEqual(port.getPairing().pairingCode, code);
    assert.strictEqual(seen.length, 1);
});
