/**
 * Tests del adaptador de Baileys (Fase A5), TODOS sin red: `socketFactory`,
 * `authStateFactory` y `fetchVersion` están inyectados (ver baileysFake.js),
 * así que nunca se toca `@whiskeysockets/baileys` de verdad más allá de sus
 * funciones puras (Browsers.ubuntu, makeCacheableSignalKeyStore,
 * normalizeMessageContent/getContentType, DisconnectReason).
 */

'use strict';

const { test } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BaileysPort = require('../../../messaging/adapters/baileys');
const { SendError } = require('../../../messaging/port');
const { runPortContract } = require('../port.contract');
const {
    createFakeSocketFactory, makeFakeAuthState, fakeFetchVersion, makeTextMessage,
} = require('./baileysFake');

const CHAT_2V2 = '11111@g.us';
const CHAT_4V4 = '22222@g.us';

function tmpAuthDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'baileys-test-'));
}

function makePort(opts = {}) {
    const socketFactory = opts.socketFactory || createFakeSocketFactory(opts.socketFactoryOpts);
    const port = new BaileysPort({
        enabled: true,
        authDir: opts.authDir || tmpAuthDir(),
        groupConfig: opts.groupConfig || {
            '2v2': { id: CHAT_2V2, name: 'Retas H3' },
            '4v4': { id: CHAT_4V4, name: 'Torneos Halo 3' },
        },
        socketFactory,
        authStateFactory: opts.authStateFactory || makeFakeAuthState({ registered: opts.registered ?? true }),
        fetchVersion: opts.fetchVersion || fakeFetchVersion,
        minSendIntervalMs: 0,
        ...opts.portOpts,
    });
    return { port, socketFactory };
}

async function tick(n = 1) {
    for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r));
}

console.log('\n— contrato genérico de MessagingPort (Baileys, socket falso) —');

// runPortContract espera getStatus() en el shape COMPLETO del contrato
// ({transport,state,...}); Baileys, igual que wwebjs.js, deja ese shape en
// getPortStatus() y conserva getStatus() en el shape LEGADO ({status,
// groups, configured}) por compatibilidad con health.js/adminWhatsapp.js
// (ver el JSDoc de la clase). Se envuelve SOLO en esta copia de prueba.
function makeContractPort() {
    const { port } = makePort();
    port.getStatus = port.getPortStatus.bind(port);
    return port;
}
runPortContract(() => makeContractPort());

console.log('\n— ciclo de vida —');

test('start() conecta con el socket falso y queda ready', async () => {
    const { port, socketFactory } = makePort();
    await port.start();
    assert.strictEqual(port.isReady(), true);
    assert.strictEqual(port.getPortStatus().state, 'ready');
    assert.strictEqual(socketFactory.sockets.length, 1);
    await port.stop();
});

test('getStatus() (shape legado) mapea los states del contrato', async () => {
    const { port } = makePort({ socketFactoryOpts: { autoOpen: false } });
    assert.strictEqual(port.getStatus().status, 'initializing'); // 'starting', antes de start()
    assert.strictEqual(port.getStatus().transport, 'baileys');
    assert.deepStrictEqual(Object.keys(port.getStatus()).sort(), ['configured', 'groups', 'status', 'transport'].sort());

    const startPromise = port.start();
    await tick(3);
    assert.ok(['waiting_qr', 'initializing'].includes(port.getStatus().status));

    // Abrir a mano (autoOpen:false) para no dejar start() colgado
    port.sock.ev.emit('connection.update', { connection: 'open' });
    await startPromise;
    assert.strictEqual(port.getStatus().status, 'ready');
    await port.stop();
    assert.strictEqual(port.getStatus().status, 'disconnected');
});

test('stop() dos veces no truena y deja isReady()=false', async () => {
    const { port } = makePort();
    await port.start();
    await port.stop();
    await port.stop();
    assert.strictEqual(port.isReady(), false);
});

console.log('\n— pairing —');

test('un evento connection.update con qr emite "pairing" y pone waiting_pairing', async () => {
    const { port } = makePort({ socketFactoryOpts: { autoOpen: false } });
    const pairingEvents = [];
    port.on('pairing', p => pairingEvents.push(p));
    port.start();
    await tick(3);
    port.sock.ev.emit('connection.update', { qr: 'QR-DATA-1' });
    assert.strictEqual(port.getPairing().qr, 'QR-DATA-1');
    assert.strictEqual(port.getPortStatus().state, 'waiting_pairing');
    assert.strictEqual(pairingEvents.at(-1).qr, 'QR-DATA-1');
    await port.stop();
});

test('requestPairingCode delega en sock.requestPairingCode y guarda el código', async () => {
    const { port } = makePort({ registered: false, socketFactoryOpts: { autoOpen: false } });
    port.start();
    await tick(3);
    const code = await port.requestPairingCode('+52 155 0000 0000');
    assert.strictEqual(code, 'CODE-5215500000000');
    assert.strictEqual(port.getPairing().pairingCode, code);
    await port.stop();
});

test('requestPairingCode ya registrado (o sin socket) no está soportado', async () => {
    const { NotSupportedError } = require('../../../messaging/port');
    const { port } = makePort();
    await assert.rejects(() => port.requestPairingCode('5215500000000'), NotSupportedError);
    await port.start();
    await assert.rejects(() => port.requestPairingCode('5215500000000'), NotSupportedError); // ya registered:true
    await port.stop();
});

console.log('\n— reconexión / DisconnectReason —');

test('DisconnectReason.restartRequired (515) reconecta de inmediato con un socket nuevo', async () => {
    const { port, socketFactory } = makePort();
    await port.start();
    assert.strictEqual(socketFactory.sockets.length, 1);
    const generation = port._generation;
    await port._onClose({ error: { output: { statusCode: 515 } } }, generation);
    await tick(3);
    assert.strictEqual(socketFactory.sockets.length, 2, 'debió abrir un socket nuevo');
    await port.stop();
});

test('DisconnectReason.loggedOut (401) pone logged_out, pone en cuarentena el auth dir y re-empareja', async () => {
    const authDir = tmpAuthDir();
    const { port, socketFactory } = makePort({ authDir });
    await port.start();
    const authPath = port.authPath;
    assert.ok(fs.existsSync(authPath));

    const states = [];
    port.on('status', s => states.push(s.state));
    const generation = port._generation;
    await port._onClose({ error: { output: { statusCode: 401 } } }, generation);
    await tick(3);

    assert.ok(states.includes('logged_out'), `no se vio logged_out: ${states.join(',')}`);
    assert.ok(!fs.existsSync(authPath) || fs.readdirSync(authPath).length === 0, 'el auth dir viejo debió vaciarse/renombrarse');
    const siblings = fs.readdirSync(authDir);
    assert.ok(siblings.some(name => name.startsWith('baileys.loggedout-')), `no se encontró el directorio en cuarentena: ${siblings.join(',')}`);
    assert.strictEqual(socketFactory.sockets.length, 2, 'debió reintentar con un socket nuevo tras el logout');
    await port.stop();
});

test('DisconnectReason.badSession (500) pone en cuarentena y reintenta', async () => {
    const authDir = tmpAuthDir();
    const { port, socketFactory } = makePort({ authDir });
    await port.start();
    const generation = port._generation;
    await port._onClose({ error: { output: { statusCode: 500 } } }, generation);
    await tick(3);
    const siblings = fs.readdirSync(authDir);
    assert.ok(siblings.some(name => name.startsWith('baileys.badsession-')));
    assert.strictEqual(socketFactory.sockets.length, 2);
    await port.stop();
});

test('DisconnectReason.connectionReplaced (440) pone "replaced" y agenda un reintento (no inmediato)', async () => {
    const { port, socketFactory } = makePort();
    await port.start();
    const generation = port._generation;
    await port._onClose({ error: { output: { statusCode: 440 } } }, generation);
    assert.strictEqual(port.getPortStatus().state, 'replaced');
    await tick(3);
    assert.strictEqual(socketFactory.sockets.length, 1, 'no debe reconectar de inmediato (retry a 5 min)');
    assert.ok(port._reconnectTimer, 'debe haber un timer de reintento agendado');
    clearTimeout(port._reconnectTimer);
    await port.stop();
});

test('DisconnectReason.forbidden (403) pone "stopped" y NO reintenta solo', async () => {
    const { port, socketFactory } = makePort();
    await port.start();
    const generation = port._generation;
    await port._onClose({ error: { output: { statusCode: 403 } } }, generation);
    assert.strictEqual(port.getPortStatus().state, 'stopped');
    await tick(3);
    assert.strictEqual(socketFactory.sockets.length, 1);
    assert.strictEqual(port._reconnectTimer, null);
});

test('un motivo desconocido reconecta con backoff y alerta tras 5 fallos seguidos', async () => {
    const { port } = makePort();
    await port.start();
    const alerts = [];
    port.setAlertHandler(text => { alerts.push(text); return true; });

    const generation = port._generation;
    for (let i = 1; i <= 5; i++) {
        await port._onClose({ error: { output: { statusCode: 408 } } }, generation);
    }
    assert.strictEqual(port.getPortStatus().state, 'reconnecting');
    assert.strictEqual(port.consecutiveFailures, 5);
    await tick(2); // notifyAlert es fire-and-forget (Promise.resolve().then(...))
    assert.ok(alerts.some(a => a.includes('5 reconexiones')), `alertas vistas: ${JSON.stringify(alerts)}`);
    if (port._reconnectTimer) clearTimeout(port._reconnectTimer);
});

console.log('\n— identidad propia / self —');

test('_onOpen deriva self de sock.user.id/.lid', async () => {
    const { port } = makePort();
    await port.start();
    const self = port.getSelfIdentity();
    assert.strictEqual(self.pn, '5215500000000');
    assert.strictEqual(self.lid, '900000000001');
    const own = port.getOwnIds();
    assert.ok(own.has('5215500000000@c.us'));
    assert.ok(own.has('900000000001@lid'));
    await port.stop();
});

console.log('\n— mensajes entrantes (messages.upsert) —');

test('conversation simple emite "message" con el texto y sender resueltos', async () => {
    const { port } = makePort();
    await port.start();
    const seen = [];
    port.on('message', m => seen.push(m));

    port.sock.ev.emit('messages.upsert', {
        type: 'notify',
        messages: [makeTextMessage({ chatId: CHAT_2V2, participant: '5215511111111@s.whatsapp.net', text: '!hola' })],
    });

    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0].text, '!hola');
    assert.strictEqual(seen[0].format, '2v2');
    assert.deepStrictEqual(seen[0].sender, { pn: '5215511111111' });
    await port.stop();
});

test('extendedTextMessage con mentionedJid resuelve mentions[] como Identity[]', async () => {
    const { port } = makePort();
    await port.start();
    const seen = [];
    port.on('message', m => seen.push(m));

    port.sock.ev.emit('messages.upsert', {
        type: 'notify',
        messages: [makeTextMessage({
            chatId: CHAT_2V2,
            participant: '5215511111111@s.whatsapp.net',
            text: '!caracola @a @b',
            mentions: ['5215522222222@s.whatsapp.net', '900000000099@lid'],
        })],
    });

    assert.strictEqual(seen.length, 1);
    assert.deepStrictEqual(seen[0].mentions, [{ pn: '5215522222222' }, { lid: '900000000099' }]);
    await port.stop();
});

test('participantAlt se fusiona con la identidad del remitente', async () => {
    const { port } = makePort();
    await port.start();
    const seen = [];
    port.on('message', m => seen.push(m));

    port.sock.ev.emit('messages.upsert', {
        type: 'notify',
        messages: [makeTextMessage({
            chatId: CHAT_2V2,
            participant: '900000000042@lid',
            participantAlt: '5215533333333@s.whatsapp.net',
            text: 'hola',
        })],
    });

    assert.deepStrictEqual(seen[0].sender, { lid: '900000000042', pn: '5215533333333' });
    await port.stop();
});

test('fromMe:true atribuye el mensaje a la identidad propia', async () => {
    const { port } = makePort();
    await port.start();
    const seen = [];
    port.on('message', m => seen.push(m));

    port.sock.ev.emit('messages.upsert', {
        type: 'notify',
        messages: [makeTextMessage({ chatId: CHAT_2V2, text: '!rondas', fromMe: true })],
    });

    assert.strictEqual(seen[0].fromMe, true);
    assert.strictEqual(seen[0].sender.pn, '5215500000000');
    await port.stop();
});

test('un chat que no es ninguno de los grupos configurados se ignora por completo', async () => {
    const { port } = makePort();
    await port.start();
    const seen = [];
    port.on('message', m => seen.push(m));
    port.sock.ev.emit('messages.upsert', {
        type: 'notify',
        messages: [makeTextMessage({ chatId: 'otro-grupo@g.us', text: 'hola' })],
    });
    assert.strictEqual(seen.length, 0);
    await port.stop();
});

test('type "append" (historial) se ignora sin emitir nada', async () => {
    const { port } = makePort();
    await port.start();
    const seen = [];
    port.on('message', m => seen.push(m));
    port.sock.ev.emit('messages.upsert', {
        type: 'append',
        messages: [makeTextMessage({ chatId: CHAT_2V2, text: 'viejo' })],
    });
    assert.strictEqual(seen.length, 0);
    await port.stop();
});

test('ephemeralMessage (normalizeMessageContent) se desenvuelve y sí se procesa', async () => {
    const { port } = makePort();
    await port.start();
    const seen = [];
    port.on('message', m => seen.push(m));

    port.sock.ev.emit('messages.upsert', {
        type: 'notify',
        messages: [{
            key: { remoteJid: CHAT_2V2, id: 'EPH1', participant: '5215511111111@s.whatsapp.net' },
            messageTimestamp: Math.floor(Date.now() / 1000),
            message: { ephemeralMessage: { message: { conversation: '!comandos' } } },
        }],
    });

    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0].text, '!comandos');
    await port.stop();
});

test('messages.update con status>=2 emite "ack"', async () => {
    const { port } = makePort();
    await port.start();
    const acks = [];
    port.on('ack', a => acks.push(a));
    port.sock.ev.emit('messages.update', [{ key: { id: 'wa-1' }, update: { status: 3 } }]);
    port.sock.ev.emit('messages.update', [{ key: { id: 'wa-2' }, update: { status: 1 } }]); // <2: no ack
    assert.deepStrictEqual(acks, [{ id: 'wa-1', status: 3 }]);
    await port.stop();
});

console.log('\n— envíos —');

test('sendText manda {text, mentions} y devuelve {id}', async () => {
    const { port } = makePort();
    await port.start();
    const result = await port.sendText(CHAT_2V2, 'hola', { mentions: ['5215511111111@s.whatsapp.net'] });
    assert.strictEqual(typeof result.id, 'string');
    assert.deepStrictEqual(port.sock.sent[0].content, { text: 'hola', mentions: ['5215511111111@s.whatsapp.net'] });
    await port.stop();
});

test('sendImage (forma MessagingPort) manda {image:{url}, caption, mentions}', async () => {
    const { port } = makePort();
    await port.start();
    const result = await port.sendImage(CHAT_2V2, { path: '/tmp/x.png', caption: 'cap', mentions: ['a'] });
    assert.strictEqual(typeof result.id, 'string');
    assert.deepStrictEqual(port.sock.sent[0].content, { image: { url: '/tmp/x.png' }, caption: 'cap', mentions: ['a'] });
    await port.stop();
});

test('sendImage (forma heredada imagePath,caption,chatId) devuelve boolean y nunca lanza', async () => {
    const { port } = makePort();
    await port.start();
    const ok = await port.sendImage('/tmp/x.png', 'cap', CHAT_2V2);
    assert.strictEqual(ok, true);
    assert.deepStrictEqual(port.sock.sent[0].content, { image: { url: '/tmp/x.png' }, caption: 'cap', mentions: undefined });
    await port.stop();
    const okAfterStop = await port.sendImage('/tmp/x.png', 'cap', CHAT_2V2);
    assert.strictEqual(okAfterStop, false);
});

test('sendMessage heredado (text,chatId,options) devuelve boolean', async () => {
    const { port } = makePort();
    await port.start();
    const ok = await port.sendMessage('hola', CHAT_2V2, { mentions: ['x'] });
    assert.strictEqual(ok, true);
    assert.deepStrictEqual(port.sock.sent[0].content, { text: 'hola', mentions: ['x'] });
    await port.stop();
});

test('sendText en modo solo-lectura lanza SendError("read_only")', async () => {
    const { port } = makePort();
    await port.start();
    port.readOnly = true;
    await assert.rejects(() => port.sendText(CHAT_2V2, 'hola'), err => err instanceof SendError && err.code === 'read_only');
});

test('un error de socket con statusCode 403 se mapea a SendError("permanent")', async () => {
    const { port } = makePort();
    await port.start();
    port.sock.failNextSend(Object.assign(new Error('forbidden'), { output: { statusCode: 403 } }));
    await assert.rejects(() => port.sendText(CHAT_2V2, 'hola'), err => err instanceof SendError && err.code === 'permanent');
    await port.stop();
});

test('un error de socket sin statusCode reconocido se mapea a SendError("transient")', async () => {
    const { port } = makePort();
    await port.start();
    port.sock.failNextSend(new Error('network blip'));
    await assert.rejects(() => port.sendText(CHAT_2V2, 'hola'), err => err instanceof SendError && err.code === 'transient');
    await port.stop();
});

test('los envíos al mismo chat se serializan (uno a la vez, en orden)', async () => {
    const { port } = makePort({ portOpts: { minSendIntervalMs: 20 } });
    await port.start();
    const order = [];
    const p1 = port.sendText(CHAT_2V2, 'uno').then(() => order.push(1));
    const p2 = port.sendText(CHAT_2V2, 'dos').then(() => order.push(2));
    const p3 = port.sendText(CHAT_2V2, 'tres').then(() => order.push(3));
    await Promise.all([p1, p2, p3]);
    assert.deepStrictEqual(order, [1, 2, 3]);
    assert.deepStrictEqual(port.sock.sent.map(s => s.content.text), ['uno', 'dos', 'tres']);
    await port.stop();
});

test('getMessage (opción del socket) devuelve el último mensaje mandado con ese id', async () => {
    const { port } = makePort();
    await port.start();
    const { id } = await port.sendText(CHAT_2V2, 'hola');
    const stored = await port.sock.options.getMessage({ id });
    assert.deepStrictEqual(stored, { text: 'hola', mentions: undefined });
    await port.stop();
});

console.log('\n— identidad: mentionJid / resolveIdentity —');

test('mentionJid prioriza lid sobre pn; string vacío si no hay ninguno', async () => {
    const { port } = makePort();
    assert.strictEqual(port.mentionJid({ lid: '1', pn: '2' }), '1@lid');
    assert.strictEqual(port.mentionJid({ pn: '2' }), '2@s.whatsapp.net');
    assert.strictEqual(port.mentionJid({}), '');
});

test('resolveIdentity: primero la caché de participantes (groupMetadata)', async () => {
    const { port } = makePort({
        socketFactoryOpts: {
            behavior: {
                groupMetadataImpl: async (jid) => ({
                    id: jid,
                    subject: 'Grupo',
                    participants: [{ id: '5215544444444@s.whatsapp.net', phoneNumber: '5215544444444@s.whatsapp.net', lid: '900000000044@lid', admin: null }],
                }),
            },
        },
    });
    await port.start();
    const resolved = await port.resolveIdentity({ pn: '5215544444444' }, { network: false });
    assert.strictEqual(resolved.lid, '900000000044');
    await port.stop();
});

test('resolveIdentity: si no hay caché, usa sock.onWhatsApp SOLO con network:true', async () => {
    const { port } = makePort({
        socketFactoryOpts: {
            behavior: { onWhatsAppImpl: async () => [{ exists: true, jid: '900000000077@lid' }] },
        },
    });
    await port.start();
    const withoutNetwork = await port.resolveIdentity({ pn: '5215577777777' }, { network: false });
    assert.strictEqual(withoutNetwork.lid, undefined, 'sin network:true no debe golpear onWhatsApp');
    const withNetwork = await port.resolveIdentity({ pn: '5215577777777' }, { network: true });
    assert.strictEqual(withNetwork.lid, '900000000077');
    await port.stop();
});

test('resolveIdentity nunca lanza (onWhatsApp falla) y devuelve la identidad de entrada', async () => {
    const { port } = makePort({
        socketFactoryOpts: { behavior: { onWhatsAppImpl: async () => { throw new Error('boom'); } } },
    });
    await port.start();
    const resolved = await port.resolveIdentity({ pn: '5215500000001' }, { network: true });
    assert.deepStrictEqual(resolved, { pn: '5215500000001' });
    await port.stop();
});

console.log('\n— getGroupParticipants / listGroups —');

test('getGroupParticipants refleja groupMetadata (isAdmin, identity)', async () => {
    const { port } = makePort({
        socketFactoryOpts: {
            behavior: {
                groupMetadataImpl: async (jid) => ({
                    id: jid,
                    subject: 'Retas H3',
                    participants: [
                        { id: '5215588888888@s.whatsapp.net', phoneNumber: '5215588888888@s.whatsapp.net', admin: 'superadmin' },
                        { id: '900000000099@lid', lid: '900000000099@lid', admin: null },
                    ],
                }),
            },
        },
    });
    await port.start();
    const participants = await port.getGroupParticipants('2v2');
    assert.strictEqual(participants.length, 2);
    assert.strictEqual(participants[0].isAdmin, true);
    assert.deepStrictEqual(participants[0].identity, { pn: '5215588888888' });
    assert.strictEqual(participants[1].isAdmin, false);
    await port.stop();
});

test('listGroups solo devuelve los grupos configurados/resueltos (nunca la lista completa)', async () => {
    const { port } = makePort();
    await port.start();
    const groups = await port.listGroups();
    assert.strictEqual(groups.length, 2);
    assert.ok(groups.some(g => g.id === CHAT_2V2));
    assert.ok(groups.some(g => g.id === CHAT_4V4));
    await port.stop();
});
