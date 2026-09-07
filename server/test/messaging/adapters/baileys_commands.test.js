/**
 * Tests "golden" de comandos de WhatsApp (Fase A5) despachados de PUNTA A
 * PUNTA a través del adaptador de Baileys real (con socket falso, ver
 * baileysFake.js) + su commandRouter interno: `messages.upsert` del socket
 * falso -> BaileysPort emite 'message' -> commandRouter despacha -> el
 * comando real (server/commands/*.js) responde -> commandRouter contesta
 * con port.sendText -> el socket falso registra el envío.
 *
 * A diferencia de server/test/commands_golden.test.js (que llama a los
 * handlers directamente con un WhatsApp falso mínimo), esto ejercita la
 * traducción real que hace BaileysPort#registerCommand entre el ctx del
 * commandRouter (basado en Identity) y la forma heredada que esperan los
 * comandos ({format, args, msg, mentionedIds, senderId}).
 */

'use strict';

const { test } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BaileysPort = require('../../../messaging/adapters/baileys');
const { registerAll } = require('../../../commands');
const { createGamesCache } = require('../../../domain/gamesCache');
const { makeLock } = require('../../../state/locks');
const { logger } = require('../../../logger');
const {
    createFakeSocketFactory, makeFakeAuthState, fakeFetchVersion, makeTextMessage,
} = require('./baileysFake');

const CHAT_2V2 = '11111@g.us';

const COMANDOS_2V2 = [
    '*Comandos del bot*',
    '• *!partidas* — últimas 10 partidas',
    '• *!caracola @P1 @P2 @P3 @P4* — equipos parejos (alias *!equipos*)',
    '• *!soy <gamertag>* — regístrate con tu gamertag',
    '• *!roster* — quién está registrado',
    '• *!comandos* — esta lista (alias *!ayuda*)',
    '• *!rondas* — marcador de la noche (rondas Bo3 y cuenta)',
    '• *!rondas reset* — marcador en ceros',
    '• *!perdida* — tu equipo da por perdida la partida en curso (W.O.)',
    '• *!anular* — anula la última partida (se jugó por error)',
    '',
    'Solo admin:',
    '• *!vincula @persona <gamertag>* — registra a otra persona',
    '• *!marcador @persona 2-1 [ronda 1-0]* — corrige el marcador si el bot se perdió partidas',
    '• *!perdida deshacer* · *!anular deshacer* · *!marcador deshacer* · *!roster unlink <gamertag>*',
].join('\n');

function fakeSupabase() {
    return {
        async getAllValidGamesWithPlayers() { return []; },
        async getRecentGamesWithPlayers() { return []; },
    };
}

async function setup({ adminJids = '' } = {}) {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'baileys-commands-'));
    const authDir = fs.mkdtempSync(path.join(os.tmpdir(), 'baileys-commands-auth-'));
    const socketFactory = createFakeSocketFactory();

    const port = new BaileysPort({
        enabled: true,
        authDir,
        groupConfig: { '2v2': { id: CHAT_2V2, name: 'Retas H3' } },
        socketFactory,
        authStateFactory: makeFakeAuthState({ registered: true }),
        fetchVersion: fakeFetchVersion,
        minSendIntervalMs: 0,
    });
    await port.start();

    const supabase = fakeSupabase();
    const ctx = {
        config: { WHATSAPP_ADMIN_JIDS: adminJids },
        logger,
        supabase,
        whatsapp: port,
        discord: {},
        discord4v4: {},
        renderer: {},
        alerts: { alert: async () => false },
        outputDir,
        gamesCache: createGamesCache({ supabase, ttlMs: 60_000 }),
        locks: {
            withRosterLock: makeLock(),
            withForfeitLock: makeLock(),
            withAnularLock: makeLock(),
            withAjusteLock: makeLock(),
            withSaldosLock: makeLock(),
        },
    };

    registerAll(port, ctx);
    return { port, ctx };
}

/** Manda un mensaje entrante por el socket falso y espera a que se despache. */
async function sendIncoming(port, opts) {
    port.sock.ev.emit('messages.upsert', { type: 'notify', messages: [makeTextMessage({ chatId: CHAT_2V2, ...opts })] });
    // handleIncoming (commandRouter) es async y fire-and-forget: varias
    // vueltas de microtask/lock/gamesCache antes de llegar a sendText.
    for (let i = 0; i < 6; i++) await new Promise(r => setImmediate(r));
}

console.log('\n— !comandos / !ayuda —');

test('!comandos responde la lista exacta (vía Baileys + commandRouter)', async () => {
    const { port } = await setup();
    await sendIncoming(port, { participant: '5215500000000@s.whatsapp.net', text: '!comandos' });
    assert.strictEqual(port.sock.sent.length, 1);
    assert.strictEqual(port.sock.sent[0].content.text, COMANDOS_2V2);
    await port.stop();
});

test('!ayuda es alias de !comandos', async () => {
    const { port } = await setup();
    await sendIncoming(port, { participant: '5215500000000@s.whatsapp.net', text: '!ayuda' });
    assert.strictEqual(port.sock.sent[0].content.text, COMANDOS_2V2);
    await port.stop();
});

console.log('\n— !rondas —');

test('!rondas sin partidas responde "Sin retas registradas todavía."', async () => {
    const { port } = await setup();
    await sendIncoming(port, { participant: '5215500000000@s.whatsapp.net', text: '!rondas' });
    assert.strictEqual(port.sock.sent[0].content.text, 'Sin retas registradas todavía.');
    await port.stop();
});

console.log('\n— !soy —');

test('!soy sin argumento y sin registrar responde el uso', async () => {
    const { port } = await setup();
    await sendIncoming(port, { participant: '5215500000000@s.whatsapp.net', text: '!soy' });
    assert.strictEqual(port.sock.sent[0].content.text, 'No estás registrado. Uso: !soy <tu gamertag>');
    await port.stop();
});

test('!soy Fulano registra el gamertag y !soy después lo confirma', async () => {
    const { port } = await setup();
    await sendIncoming(port, { participant: '5215511111111@s.whatsapp.net', text: '!soy Fulano' });
    assert.strictEqual(
        port.sock.sent[0].content.text,
        'Registrado: *Fulano*. Cero partidas todavía: tu rating será provisional hasta que juegues.',
    );
    await sendIncoming(port, { participant: '5215511111111@s.whatsapp.net', text: '!soy' });
    assert.strictEqual(port.sock.sent[1].content.text, 'Estás registrado como *Fulano*. Para cambiar: !soy <gamertag>');
    await port.stop();
});

console.log('\n— admin (!vincula) vía Identity real —');

test('!vincula por un admin (WHATSAPP_ADMIN_JIDS) vincula y responde "Listo"', async () => {
    const adminPn = '5215500000000';
    const { port } = await setup({ adminJids: `${adminPn}@c.us` });
    await sendIncoming(port, {
        participant: `${adminPn}@s.whatsapp.net`,
        text: '!vincula @5215533333333 PruebaTag',
        mentions: ['5215533333333@s.whatsapp.net'],
    });
    assert.strictEqual(
        port.sock.sent[0].content.text,
        'Listo: …3333 es *PruebaTag* (sin partidas todavía: rating provisional).',
    );
    await port.stop();
});

test('!vincula por alguien que NO es admin no vincula nada', async () => {
    const { port } = await setup(); // sin WHATSAPP_ADMIN_JIDS
    await sendIncoming(port, {
        participant: '5215599999999@s.whatsapp.net',
        text: '!vincula @5215533333333 PruebaTag',
        mentions: ['5215533333333@s.whatsapp.net'],
    });
    assert.strictEqual(port.sock.sent[0].content.text, 'Solo un admin puede hacer eso.');
    await port.stop();
});
