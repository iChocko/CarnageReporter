/**
 * Tests de ShadowPort (Fase A3, comparación en Fase A5): modo solo-lectura,
 * reenvío de eventos, y el `shadow.compare` contra un puerto primario (ver
 * server/messaging/adapters/shadow.js). Usa dos FakePort (uno como "primario",
 * otro como el interno del shadow) porque la lógica de comparación es
 * transporte-neutral — no depende de Baileys ni de whatsapp-web.js.
 */

'use strict';

const { test } = require('node:test');
const assert = require('assert');

const { createFakePort } = require('../../messaging/adapters/fake');
const { createShadowPort } = require('../../messaging/adapters/shadow');
const { SendError } = require('../../messaging/port');

const CHAT_2V2 = '11111@g.us';

function fakeLogger() {
    const lines = [];
    return { logger: { info: (obj, msg) => lines.push({ ...obj, msg }) }, lines };
}

console.log('\n— solo-lectura —');

test('sendText/sendImage siempre truenan con SendError("read_only")', async () => {
    const inner = createFakePort({ groups: { '2v2': { id: CHAT_2V2 } } });
    await inner.start();
    const shadow = createShadowPort(inner);
    await assert.rejects(() => shadow.sendText(CHAT_2V2, 'hola'), err => err instanceof SendError && err.code === 'read_only');
    await assert.rejects(() => shadow.sendImage(CHAT_2V2, { path: '/x.png' }), err => err instanceof SendError && err.code === 'read_only');
    assert.strictEqual(inner.sent.length, 0, 'el puerto interno nunca debe recibir el envío');
});

test('getStatus() delega al interno pero fuerza readOnly:true', async () => {
    const inner = createFakePort();
    await inner.start();
    const shadow = createShadowPort(inner);
    assert.strictEqual(shadow.getStatus().readOnly, true);
    assert.strictEqual(shadow.getStatus().state, 'ready');
});

test('status/pairing/ack del interno se reenvían tal cual', async () => {
    const inner = createFakePort();
    const shadow = createShadowPort(inner);
    const statuses = [];
    const acks = [];
    shadow.on('status', s => statuses.push(s));
    shadow.on('ack', a => acks.push(a));
    await inner.start();
    inner.emit('ack', { id: '1', status: 'delivered' });
    assert.ok(statuses.length >= 1);
    assert.deepStrictEqual(acks, [{ id: '1', status: 'delivered' }]);
});

console.log('\n— shadow.message —');

test('todo mensaje del interno se loggea (shadow.message) y se reemite', async () => {
    const inner = createFakePort({ groups: { '2v2': { id: CHAT_2V2 } } });
    await inner.start();
    const { logger, lines } = fakeLogger();
    const shadow = createShadowPort(inner, { logger });
    const seen = [];
    shadow.on('message', m => seen.push(m));

    inner.emitIncoming({ id: 'm1', chatId: CHAT_2V2, text: '!hola', sender: { pn: '1' } });

    assert.strictEqual(seen.length, 1);
    const logged = lines.find(l => l.msg === 'shadow.message');
    assert.ok(logged, 'debió loggear shadow.message');
    assert.strictEqual(logged.id, 'm1');
    assert.strictEqual(logged.text, '!hola');
});

console.log('\n— shadow.compare (Fase A5) —');

test('sin `primary`, nunca loggea shadow.compare', async () => {
    const inner = createFakePort({ groups: { '2v2': { id: CHAT_2V2 } } });
    await inner.start();
    const { logger, lines } = fakeLogger();
    createShadowPort(inner, { logger });
    inner.emitIncoming({ id: 'm1', chatId: CHAT_2V2, text: 'hola', sender: { pn: '1' } });
    assert.ok(!lines.some(l => l.msg === 'shadow.compare'));
});

test('con `primary` y el MISMO id, sender/text/mentions iguales -> match:true', async () => {
    const primary = createFakePort({ groups: { '2v2': { id: CHAT_2V2 } } });
    const inner = createFakePort({ groups: { '2v2': { id: CHAT_2V2 } } });
    await primary.start();
    await inner.start();
    const { logger, lines } = fakeLogger();
    createShadowPort(inner, { logger, primary });

    const shared = { id: 'shared-1', chatId: CHAT_2V2, text: '!rondas', sender: { pn: '1' }, mentions: [{ pn: '2' }] };
    primary.emitIncoming(shared);
    inner.emitIncoming({ ...shared });

    const compare = lines.find(l => l.msg === 'shadow.compare');
    assert.ok(compare, 'debió loggear shadow.compare');
    assert.strictEqual(compare.id, 'shared-1');
    assert.strictEqual(compare.match, true);
});

test('con `primary` y el mismo id pero texto distinto -> match:false', async () => {
    const primary = createFakePort({ groups: { '2v2': { id: CHAT_2V2 } } });
    const inner = createFakePort({ groups: { '2v2': { id: CHAT_2V2 } } });
    await primary.start();
    await inner.start();
    const { logger, lines } = fakeLogger();
    createShadowPort(inner, { logger, primary });

    primary.emitIncoming({ id: 'shared-2', chatId: CHAT_2V2, text: '!rondas', sender: { pn: '1' } });
    inner.emitIncoming({ id: 'shared-2', chatId: CHAT_2V2, text: '!rondas reset', sender: { pn: '1' } });

    const compare = lines.find(l => l.msg === 'shadow.compare');
    assert.strictEqual(compare.match, false);
});

test('con `primary` pero un id que el primario nunca vio, no loggea shadow.compare', async () => {
    const primary = createFakePort({ groups: { '2v2': { id: CHAT_2V2 } } });
    const inner = createFakePort({ groups: { '2v2': { id: CHAT_2V2 } } });
    await primary.start();
    await inner.start();
    const { logger, lines } = fakeLogger();
    createShadowPort(inner, { logger, primary });

    inner.emitIncoming({ id: 'unico-del-shadow', chatId: CHAT_2V2, text: 'x', sender: { pn: '1' } });

    assert.ok(!lines.some(l => l.msg === 'shadow.compare'));
});

test('mentions en distinto orden pero mismo contenido -> match:true (se ordenan antes de comparar)', async () => {
    const primary = createFakePort({ groups: { '2v2': { id: CHAT_2V2 } } });
    const inner = createFakePort({ groups: { '2v2': { id: CHAT_2V2 } } });
    await primary.start();
    await inner.start();
    const { logger, lines } = fakeLogger();
    createShadowPort(inner, { logger, primary });

    primary.emitIncoming({ id: 'shared-3', chatId: CHAT_2V2, text: '!caracola', sender: { pn: '1' }, mentions: [{ pn: '2' }, { lid: '3' }] });
    inner.emitIncoming({ id: 'shared-3', chatId: CHAT_2V2, text: '!caracola', sender: { pn: '1' }, mentions: [{ lid: '3' }, { pn: '2' }] });

    const compare = lines.find(l => l.msg === 'shadow.compare');
    assert.strictEqual(compare.match, true);
});
