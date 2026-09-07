/**
 * Tests "golden" de comandos de WhatsApp (Fase A2): registra los comandos
 * reales vía registerAll() con un WhatsApp falso y un OUTPUT_DIR temporal
 * (roster/forfeits/ajustes/anuladas vacíos), y compara las respuestas
 * byte-por-byte contra los textos EXACTOS del index.js monolítico antes de
 * partirlo (commit 0f602fa) — así una futura reorganización de código no
 * puede cambiar sin querer lo que el bot responde en el grupo.
 */

const { test } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { registerAll } = require('../commands');
const { createGamesCache } = require('../domain/gamesCache');
const { makeLock } = require('../state/locks');
const { logger } = require('../logger');

// Textos tal cual estaban en server/index.js (commit 0f602fa) antes de la Fase A2.
const MARCADOR_USAGE = 'Uso (solo admin): corrige el marcador si el bot se perdió partidas.\n' +
    '• *!marcador @persona 2-1* — la serie de su equipo queda 2-1\n' +
    '• *!marcador @persona 2-1 ronda 1-0* — serie 2-1 y ronda en curso 1-0\n' +
    '• *!marcador @persona ronda 1-0* — solo la ronda en curso\n' +
    '• *!marcador deshacer* — revierte el último ajuste\n' +
    'También con gamertag escrito: !marcador Fulano 2-1';

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

function fakeWhatsapp() {
    const commands = new Map();
    return {
        commands,
        registerCommand(trigger, handler) { commands.set(trigger, handler); },
        getOwnIds() { return new Set(); },
        async resolveLidPn(jids) { return jids.map(() => ({})); },
        async getContactInfo() { return {}; },
        isReady() { return false; },
    };
}

function buildCtx({ adminJids = '' } = {}) {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'commands-golden-'));
    const supabase = fakeSupabase();
    return {
        config: { WHATSAPP_ADMIN_JIDS: adminJids },
        logger,
        supabase,
        whatsapp: null, // se asigna abajo tras crear el fake
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
}

function setup(ctxOpts = {}) {
    const ctx = buildCtx(ctxOpts);
    const whatsapp = fakeWhatsapp();
    ctx.whatsapp = whatsapp;
    registerAll(whatsapp, ctx);
    return whatsapp.commands;
}

test('!comandos en el grupo 2v2 responde la lista exacta de comandos', async () => {
    const commands = setup();
    const reply = await commands.get('!comandos')({ format: '2v2', args: '', msg: {}, mentionedIds: [], senderId: null });
    assert.strictEqual(reply, COMANDOS_2V2);
});

test('!ayuda es alias de !comandos (mismo texto)', async () => {
    const commands = setup();
    const reply = await commands.get('!ayuda')({ format: '2v2', args: '', msg: {}, mentionedIds: [], senderId: null });
    assert.strictEqual(reply, COMANDOS_2V2);
});

test('!rondas sin partidas registradas responde "Sin retas registradas todavía."', async () => {
    const commands = setup();
    const reply = await commands.get('!rondas')({ format: '2v2', args: '', msg: {}, mentionedIds: [], senderId: null });
    assert.strictEqual(reply, 'Sin retas registradas todavía.');
});

test('!soy sin argumento y sin registrar responde el uso', async () => {
    const commands = setup();
    const reply = await commands.get('!soy')({ format: '2v2', args: '', msg: {}, mentionedIds: [], senderId: '5215500000000@c.us' });
    assert.strictEqual(reply, 'No estás registrado. Uso: !soy <tu gamertag>');
});

test('!marcador sin argumentos (solo admin) responde el uso completo', async () => {
    const commands = setup();
    const reply = await commands.get('!marcador')({ format: '2v2', args: '', msg: {}, mentionedIds: [], senderId: '5215500000000@c.us' });
    assert.strictEqual(reply, MARCADOR_USAGE);
});

// Fase A3: cobertura extra de !vincula (admin) y !caracola (menciones) sobre
// el mismo fakeWhatsapp de siempre (sin tocar su forma), ahora que
// isAdminSender/resolveMentionsToTags viven sobre Identity (server/messaging/jid.js).

test('!vincula @persona <gamertag> por un admin (WHATSAPP_ADMIN_JIDS) vincula y responde "Listo"', async () => {
    const adminJid = '5215500000000@c.us';
    const commands = setup({ adminJids: adminJid });
    const reply = await commands.get('!vincula')({
        format: '2v2',
        args: 'PruebaTag',
        msg: {},
        mentionedIds: ['5215533333333@c.us'],
        senderId: adminJid,
    });
    assert.strictEqual(reply, 'Listo: …3333 es *PruebaTag* (sin partidas todavía: rating provisional).');
});

test('!vincula por alguien que NO es admin no vincula nada', async () => {
    const commands = setup(); // sin WHATSAPP_ADMIN_JIDS
    const reply = await commands.get('!vincula')({
        format: '2v2',
        args: 'PruebaTag',
        msg: {},
        mentionedIds: ['5215533333333@c.us'],
        senderId: '5215599999999@c.us',
    });
    assert.strictEqual(reply, 'Solo un admin puede hacer eso.');
});

test('!caracola con dos menciones sin registrar en el roster responde "Sin registrar" con ambas', async () => {
    const commands = setup();
    const reply = await commands.get('!caracola')({
        format: '2v2',
        args: '',
        msg: {},
        mentionedIds: ['5215511111111@c.us', '5215522222222@c.us'],
        senderId: null,
    });
    assert.strictEqual(reply, [
        'Sin registrar: …1111, …2222.',
        'Que manden *!soy <gamertag>* o los vincula un admin con *!vincula @persona <gamertag>*.',
    ].join('\n'));
});
