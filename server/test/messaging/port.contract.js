/**
 * Contrato de MessagingPort (Fase A3): una suite de tests reutilizable que
 * cualquier adaptador debería pasar. Se corre contra el FakePort en
 * server/test/messaging/fake.test.js (siempre, en CI); correrla contra un
 * adaptador real (wwebjs) requiere una sesión de WhatsApp de verdad, así
 * que queda detrás de `WA_CONTRACT=1` y NUNCA se activa en CI (ver el
 * comentario en fake.test.js y el reporte de la Fase A3 sobre las
 * excepciones documentadas del adaptador de wwebjs a este contrato).
 *
 * Uso:
 *   const { runPortContract } = require('./port.contract');
 *   runPortContract(() => createFakePort(), { skipSend: false });
 *
 * `makePort` debe devolver un puerto NUEVO y aún no iniciado en cada
 * llamada (los tests llaman `start()` ellos mismos).
 */

'use strict';

const { test } = require('node:test');
const assert = require('assert');

const VALID_STATES = new Set([
    'disabled', 'starting', 'waiting_pairing', 'connecting',
    'ready', 'reconnecting', 'logged_out', 'replaced', 'stopped',
]);

/**
 * @param {() => import('../../messaging/port').MessagingPort} makePort
 * @param {{skipSend?: boolean}} [opts] - skipSend:true para un adaptador que
 *   no puede mandar mensajes de verdad en el entorno de test.
 */
function runPortContract(makePort, opts = {}) {
    const { skipSend = false } = opts;

    test('[contract] getStatus() antes de start() trae un state válido', async () => {
        const port = makePort();
        const status = port.getStatus();
        assert.ok(VALID_STATES.has(status.state), `state inválido: ${status.state}`);
        assert.strictEqual(typeof status.transport, 'string');
        assert.ok(status.transport.length > 0);
    });

    test('[contract] start() deja isReady()=true y getStatus().state="ready"', async () => {
        const port = makePort();
        await port.start();
        assert.strictEqual(port.isReady(), true);
        assert.strictEqual(port.getStatus().state, 'ready');
    });

    test('[contract] stop() deja isReady()=false', async () => {
        const port = makePort();
        await port.start();
        await port.stop();
        assert.strictEqual(port.isReady(), false);
    });

    test('[contract] groupIdFor/formatForChat son inversos entre sí para un grupo configurado', async () => {
        const port = makePort();
        await port.start();
        for (const format of ['2v2', '4v4']) {
            const chatId = port.groupIdFor(format);
            if (!chatId) continue; // formato sin grupo configurado: válido, se salta
            assert.strictEqual(port.formatForChat(chatId), format);
        }
    });

    test('[contract] mentionJid(identity) da un string (vacío si la identidad no se reconoce)', async () => {
        const port = makePort();
        await port.start();
        assert.strictEqual(typeof port.mentionJid({ pn: '5215551234567' }), 'string');
        assert.strictEqual(typeof port.mentionJid({}), 'string');
    });

    test('[contract] resolveIdentity nunca lanza y devuelve un objeto', async () => {
        const port = makePort();
        await port.start();
        const result = await port.resolveIdentity({ pn: '5215551234567' });
        assert.strictEqual(typeof result, 'object');
        assert.notStrictEqual(result, null);
    });

    test('[contract] listGroups()/getGroupParticipants() nunca lanzan y devuelven arrays', async () => {
        const port = makePort();
        await port.start();
        assert.ok(Array.isArray(await port.listGroups()));
        assert.ok(Array.isArray(await port.getGroupParticipants('2v2')));
    });

    test('[contract] emite "message" al recibir un mensaje entrante (si el adaptador lo simula)', async () => {
        const port = makePort();
        await port.start();
        if (typeof port.emitIncoming !== 'function') return; // helper de test, no todos lo tienen
        const chatId = port.groupIdFor('2v2') || 'test-chat';
        const seen = [];
        port.on('message', m => seen.push(m));
        port.emitIncoming({ chatId, text: '!hola', sender: { pn: '1' } });
        await new Promise(r => setImmediate(r));
        assert.strictEqual(seen.length, 1);
        assert.strictEqual(seen[0].text, '!hola');
        assert.deepStrictEqual(seen[0].sender, { pn: '1' });
    });

    if (!skipSend) {
        test('[contract] sendText sin chatId o sin texto lanza SendError', async () => {
            const port = makePort();
            await port.start();
            const { SendError } = require('../../messaging/port');
            await assert.rejects(() => port.sendText(null, 'hola'), SendError);
            await assert.rejects(() => port.sendText('chat', ''), SendError);
        });

        test('[contract] sendText en un puerto listo resuelve {id}', async () => {
            const port = makePort();
            await port.start();
            const chatId = port.groupIdFor('2v2') || 'test-chat';
            const result = await port.sendText(chatId, 'hola');
            assert.strictEqual(typeof result.id, 'string');
            assert.ok(result.id.length > 0);
        });

        test('[contract] sendText en un puerto no listo lanza SendError("not_ready")', async () => {
            const port = makePort();
            // Sin start(): el puerto no debe estar listo.
            const { SendError } = require('../../messaging/port');
            await assert.rejects(
                () => port.sendText(port.groupIdFor('2v2') || 'test-chat', 'hola'),
                err => err instanceof SendError && err.code === 'not_ready'
            );
        });
    }
}

module.exports = { runPortContract, VALID_STATES };
