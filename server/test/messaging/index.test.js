/**
 * Tests de la fábrica de MessagingPort (server/messaging/index.js): elección
 * de transporte por WHATSAPP_TRANSPORT/WHATSAPP_SHADOW_TRANSPORT, incluido
 * 'baileys' (Fase A5). Todo con `deps.baileys` inyectando socketFactory/
 * authStateFactory/fetchVersion falsos — nunca toca la red ni Baileys de verdad.
 */

'use strict';

const { test } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createMessagingPort } = require('../../messaging');
const { FakePort } = require('../../messaging/adapters/fake');
const BaileysPort = require('../../messaging/adapters/baileys');
const {
    createFakeSocketFactory, makeFakeAuthState, fakeFetchVersion,
} = require('./adapters/baileysFake');

function baileysDeps(overrides = {}) {
    return {
        baileys: {
            authDir: fs.mkdtempSync(path.join(os.tmpdir(), 'messaging-index-')),
            socketFactory: createFakeSocketFactory({ autoOpen: false }),
            authStateFactory: makeFakeAuthState({ registered: true }),
            fetchVersion: fakeFetchVersion,
            minSendIntervalMs: 0,
            ...overrides,
        },
    };
}

test('WHATSAPP_TRANSPORT=fake da un FakePort', () => {
    const port = createMessagingPort({ WHATSAPP_TRANSPORT: 'fake' }, { fake: { self: { pn: '1' } } });
    assert.ok(port instanceof FakePort);
    assert.strictEqual(port.shadow, undefined);
});

test('WHATSAPP_TRANSPORT desconocido lanza', () => {
    assert.throws(() => createMessagingPort({ WHATSAPP_TRANSPORT: 'zoom' }), /desconocido/);
});

test('WHATSAPP_TRANSPORT=baileys da un BaileysPort con el groupConfig de env', () => {
    const port = createMessagingPort({
        WHATSAPP_TRANSPORT: 'baileys',
        WHATSAPP_GROUP_ID: 'g2v2@g.us',
        WHATSAPP_GROUP_ID_4V4: 'g4v4@g.us',
        COMMAND_MAX_AGE_S: 30,
    }, baileysDeps());
    assert.ok(port instanceof BaileysPort);
    assert.strictEqual(port.groupIdFor('2v2'), 'g2v2@g.us');
    assert.strictEqual(port.groupIdFor('4v4'), 'g4v4@g.us');
});

test('WHATSAPP_PILOT=true + WHATSAPP_GROUP_ID_TEST mapea el grupo de prueba a 2v2', () => {
    const port = createMessagingPort({
        WHATSAPP_TRANSPORT: 'baileys',
        WHATSAPP_GROUP_ID: 'g2v2-prod@g.us',
        WHATSAPP_PILOT: true,
        WHATSAPP_GROUP_ID_TEST: 'g-piloto@g.us',
    }, baileysDeps());
    assert.strictEqual(port.groupIdFor('2v2'), 'g-piloto@g.us');
});

test('WHATSAPP_SHADOW_TRANSPORT="fake" agrega un ShadowPort con el primario como referencia de comparación', () => {
    const port = createMessagingPort({
        WHATSAPP_TRANSPORT: 'fake',
        WHATSAPP_SHADOW_TRANSPORT: 'fake',
    }, { fake: {} });
    assert.ok(port.shadow, 'debe exponer .shadow');
    assert.strictEqual(port.shadow.primary, port);
});

test('WHATSAPP_SHADOW_TRANSPORT="baileys" con primario "baileys" usa su propia subcarpeta de auth (no comparte sesión)', () => {
    const port = createMessagingPort({
        WHATSAPP_TRANSPORT: 'baileys',
        WHATSAPP_SHADOW_TRANSPORT: 'baileys',
        WHATSAPP_GROUP_ID: 'g2v2@g.us',
    }, baileysDeps());
    assert.ok(port.shadow);
    assert.strictEqual(port.shadow.primary, port);
    assert.ok(port.shadow.inner instanceof BaileysPort);
    assert.strictEqual(port.shadow.inner.authSubdir, 'baileys-shadow');
    assert.notStrictEqual(port.shadow.inner.authPath, port.authPath, 'el shadow debe usar su propia subcarpeta de auth');
});

test('WHATSAPP_SHADOW_TRANSPORT="baileys" con primario "fake" también compara (caso real: primario wwebjs + shadow baileys)', () => {
    // No se instancia wwebjs de verdad (requiere whatsapp-web.js real); se usa
    // 'fake' de primario para no pagar ese costo en el test, pero la
    // comparación es transporte-neutral (ver adapters/shadow.js) así que el
    // caso real (primario 'wwebjs' + shadow 'baileys' bajo prueba) se
    // comporta igual.
    const port = createMessagingPort({
        WHATSAPP_TRANSPORT: 'fake',
        WHATSAPP_SHADOW_TRANSPORT: 'baileys',
    }, { fake: {}, ...baileysDeps() });
    assert.ok(port.shadow);
    assert.strictEqual(port.shadow.primary, port);
});

test('WHATSAPP_SHADOW_TRANSPORT desconocido lanza', () => {
    assert.throws(
        () => createMessagingPort({ WHATSAPP_TRANSPORT: 'fake', WHATSAPP_SHADOW_TRANSPORT: 'zoom' }, { fake: {} }),
        /no soportado/,
    );
});
