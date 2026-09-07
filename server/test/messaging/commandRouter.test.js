/**
 * Tests de server/messaging/commandRouter.js (Fase A3), sobre un FakePort
 * (server/messaging/adapters/fake.js).
 */

'use strict';

const { test } = require('node:test');
const assert = require('assert');

const { createFakePort } = require('../../messaging/adapters/fake');
const { createCommandRouter } = require('../../messaging/commandRouter');

const CHAT_2V2 = '11111@g.us';

function setup(opts = {}) {
    const port = createFakePort({ groups: { '2v2': { id: CHAT_2V2, name: 'Retas H3' } } });
    port.state = 'ready';
    const calls = [];
    const router = createCommandRouter(port, {
        maxAgeSec: opts.maxAgeSec ?? 120,
        isAdmin: opts.isAdmin,
        logger: { info() {}, warn() {}, error(...a) { calls.push(a); }, debug() {} },
    });
    return { port, router, errorCalls: calls };
}

console.log('\n— match del trigger —');

test('un mensaje que empieza con el trigger exacto dispara el handler', async () => {
    const { port, router } = setup();
    let seenArgs = null;
    router.registerCommand('!hola', async ctx => { seenArgs = ctx.args; return 'Hola!'; });

    port.emitIncoming({ chatId: CHAT_2V2, text: '!hola mundo', sender: { pn: '1' } });
    await new Promise(r => setImmediate(r));

    assert.strictEqual(seenArgs, 'mundo');
    assert.strictEqual(port.sent.length, 1);
    assert.strictEqual(port.sent[0].text, 'Hola!');
});

test('texto que no empieza con "!" se ignora', async () => {
    const { port, router } = setup();
    let called = false;
    router.registerCommand('!hola', async () => { called = true; return 'x'; });
    port.emitIncoming({ chatId: CHAT_2V2, text: 'hola sin bang' });
    await new Promise(r => setImmediate(r));
    assert.ok(!called);
    assert.strictEqual(port.sent.length, 0);
});

test('un trigger no registrado no dispara nada', async () => {
    const { port, router } = setup();
    router.registerCommand('!hola', async () => 'x');
    port.emitIncoming({ chatId: CHAT_2V2, text: '!otracosa' });
    await new Promise(r => setImmediate(r));
    assert.strictEqual(port.sent.length, 0);
});

test('el match es case-insensitive en el trigger', async () => {
    const { port, router } = setup();
    router.registerCommand('!Hola', async () => 'ok');
    port.emitIncoming({ chatId: CHAT_2V2, text: '!HOLA' });
    await new Promise(r => setImmediate(r));
    assert.strictEqual(port.sent.length, 1);
});

console.log('\n— fromMe —');

test('los mensajes fromMe también se procesan', async () => {
    const { port, router } = setup();
    let seenFromMe = null;
    router.registerCommand('!hola', async ctx => { seenFromMe = ctx.fromMe; return 'ok'; });
    port.emitIncoming({ chatId: CHAT_2V2, text: '!hola', fromMe: true });
    await new Promise(r => setImmediate(r));
    assert.strictEqual(seenFromMe, true);
    assert.strictEqual(port.sent.length, 1);
});

console.log('\n— eco de la propia respuesta —');

test('un mensaje entrante con el id de una respuesta ya mandada se ignora', async () => {
    const { port, router } = setup();
    let calls = 0;
    router.registerCommand('!hola', async () => { calls++; return 'ok'; });

    port.emitIncoming({ id: 'in-1', chatId: CHAT_2V2, text: '!hola' });
    await new Promise(r => setImmediate(r));
    assert.strictEqual(calls, 1);
    const sentId = port.sent[0].id;

    // El "eco": un mensaje entrante que trae el id de la respuesta que el
    // propio router mandó (p.ej. message_create también ve los envíos propios).
    port.emitIncoming({ id: sentId, chatId: CHAT_2V2, text: '!hola' });
    await new Promise(r => setImmediate(r));
    assert.strictEqual(calls, 1, 'el handler no debe volver a correr para el eco');
});

console.log('\n— antigüedad (maxAgeSec) —');

test('un mensaje más viejo que maxAgeSec se descarta sin correr el handler', async () => {
    const { port, router } = setup({ maxAgeSec: 60 });
    let called = false;
    router.registerCommand('!rondas', async () => { called = true; return 'x'; });

    port.emitIncoming({ chatId: CHAT_2V2, text: '!rondas reset', timestamp: Date.now() - 5 * 60 * 1000 });
    await new Promise(r => setImmediate(r));

    assert.ok(!called, 'un comando viejo (replay tras reconexión) no debe correr');
    assert.strictEqual(port.sent.length, 0);
});

test('un mensaje dentro de la ventana de antigüedad sí corre', async () => {
    const { port, router } = setup({ maxAgeSec: 60 });
    let called = false;
    router.registerCommand('!rondas', async () => { called = true; return 'x'; });
    port.emitIncoming({ chatId: CHAT_2V2, text: '!rondas', timestamp: Date.now() - 5000 });
    await new Promise(r => setImmediate(r));
    assert.ok(called);
});

test('maxAgeSec=0 desactiva el chequeo de antigüedad', async () => {
    const { port, router } = setup({ maxAgeSec: 0 });
    let called = false;
    router.registerCommand('!rondas', async () => { called = true; return 'x'; });
    port.emitIncoming({ chatId: CHAT_2V2, text: '!rondas', timestamp: Date.now() - 999 * 60 * 60 * 1000 });
    await new Promise(r => setImmediate(r));
    assert.ok(called);
});

console.log('\n— reintentos de envío —');

test('sendText que falla se reintenta hasta 3 veces y luego se rinde sin tronar', async () => {
    const { port, router, errorCalls } = setup();
    let attempts = 0;
    port.sendText = async () => { attempts++; throw new Error('boom'); };
    router.registerCommand('!hola', async () => 'ok');

    port.emitIncoming({ chatId: CHAT_2V2, text: '!hola' });
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));

    assert.strictEqual(attempts, 3);
    assert.ok(errorCalls.length >= 1);
});

test('sendText que falla las primeras veces y luego funciona, sí manda la respuesta', async () => {
    const { port, router } = setup();
    let attempts = 0;
    const realSendText = port.sendText.bind(port);
    port.sendText = async (...args) => {
        attempts++;
        if (attempts < 2) throw new Error('transient');
        return realSendText(...args);
    };
    router.registerCommand('!hola', async () => 'ok');

    port.emitIncoming({ chatId: CHAT_2V2, text: '!hola' });
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));

    assert.strictEqual(attempts, 2);
    assert.strictEqual(port.sent.length, 1);
});

console.log('\n— ctx del handler —');

test('ctx trae isAdmin, isSelf, senderKeys y mentions ya resueltos', async () => {
    const { port, router } = setup({ isAdmin: async sender => sender.pn === '999' });
    let captured = null;
    router.registerCommand('!quien', async ctx => { captured = ctx; return 'ok'; });

    port.emitIncoming({
        chatId: CHAT_2V2,
        text: '!quien',
        sender: { pn: '999' },
        mentions: [{ pn: '1' }, { lid: '2' }],
    });
    await new Promise(r => setImmediate(r));

    assert.deepStrictEqual(captured.senderKeys, ['pn:999']);
    assert.strictEqual(await captured.isAdmin(), true);
    assert.strictEqual(captured.isSelf(port.getSelfIdentity()), true);
    assert.strictEqual(captured.mentions.length, 2);
});

test('una respuesta { text, mentions } manda las menciones a sendText', async () => {
    const { port, router } = setup();
    router.registerCommand('!caracola', async ctx => ({
        text: `Hola @${ctx.port.mentionJid({ pn: '1' })}`,
        mentions: [ctx.port.mentionJid({ pn: '1' })],
    }));
    port.emitIncoming({ chatId: CHAT_2V2, text: '!caracola' });
    await new Promise(r => setImmediate(r));
    assert.deepStrictEqual(port.sent[0].mentions, ['1']);
});

test('una respuesta falsy no manda nada', async () => {
    const { port, router } = setup();
    router.registerCommand('!callar', async () => null);
    port.emitIncoming({ chatId: CHAT_2V2, text: '!callar' });
    await new Promise(r => setImmediate(r));
    assert.strictEqual(port.sent.length, 0);
});

test('un handler que lanza no tumba el router (se loggea y sigue)', async () => {
    const { port, router } = setup();
    router.registerCommand('!explota', async () => { throw new Error('boom'); });
    port.emitIncoming({ chatId: CHAT_2V2, text: '!explota' });
    await new Promise(r => setImmediate(r));
    assert.strictEqual(port.sent.length, 0);
});
