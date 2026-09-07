/**
 * Tests de server/messaging/outbox.js (el worker) con un store falso en
 * memoria, un FakePort (server/messaging/adapters/fake.js) y un Discord
 * falso: backoff exponencial, 'not_ready' que no cuenta intento, 'dead' tras
 * agotar los intentos (+alerta), recoverStuck al arrancar, kick() automático
 * cuando el puerto llega a 'ready', y el hook onSent (saldos: solo corre
 * tras el envío confirmado).
 */

'use strict';

const { test } = require('node:test');
const assert = require('assert');

const { createOutboxWorker } = require('../../messaging/outbox');
const { createFakePort } = require('../../messaging/adapters/fake');

function makeFakeStore() {
    const rows = [];
    let nextId = 1;
    const calls = { markSent: [], markRetry: [], markDead: [], releaseNotReady: [], recoverStuck: [], claimDue: [] };

    return {
        rows,
        calls,
        async enqueue(row) {
            const r = { id: nextId++, status: 'pending', attempts: 0, next_attempt_at: Date.now(), ...row };
            rows.push(r);
            return { id: r.id, created: true };
        },
        async claimDue({ limitPerChannel = 1, channels = null } = {}) {
            calls.claimDue.push({ limitPerChannel, channels });
            const now = Date.now();
            const byChannel = new Map();
            const claimed = [];
            for (const row of rows) {
                if (row.status !== 'pending') continue;
                if (row.next_attempt_at > now) continue;
                if (channels && !channels.includes(row.channel)) continue;
                const list = byChannel.get(row.channel) || [];
                if (list.length >= limitPerChannel) continue;
                list.push(row);
                byChannel.set(row.channel, list);
                claimed.push(row);
            }
            for (const row of claimed) row.status = 'sending';
            return claimed.map(r => ({ ...r }));
        },
        async markSent(id, providerMessageId = null) {
            calls.markSent.push({ id, providerMessageId });
            const row = rows.find(r => r.id === id);
            row.status = 'sent';
            row.provider_message_id = providerMessageId;
        },
        async markRetry(id, { error, nextAttemptAt }) {
            calls.markRetry.push({ id, error, nextAttemptAt });
            const row = rows.find(r => r.id === id);
            row.attempts += 1;
            row.status = 'pending';
            row.next_attempt_at = nextAttemptAt;
            row.last_error = String((error && error.message) || error || '');
            return { attempts: row.attempts };
        },
        async markDead(id, error) {
            calls.markDead.push({ id, error });
            const row = rows.find(r => r.id === id);
            row.status = 'dead';
            row.last_error = String((error && error.message) || error || '');
        },
        async releaseNotReady(id) {
            calls.releaseNotReady.push(id);
            const row = rows.find(r => r.id === id);
            row.status = 'pending';
        },
        async recoverStuck(olderThanMs) {
            calls.recoverStuck.push(olderThanMs);
            return { recovered: 0 };
        },
        async stats() {
            return {
                pending: rows.filter(r => r.status === 'pending').length,
                dead: rows.filter(r => r.status === 'dead').length,
                oldestPendingSec: null,
            };
        },
        async findSentByProviderId() { return null; },
    };
}

function makeFakeDiscord() {
    const calls = [];
    let shouldFail = false;
    return {
        calls,
        setShouldFail(v) { shouldFail = v; },
        async sendImage(imagePath, gameData, players) {
            calls.push({ imagePath, gameData, players });
            return !shouldFail;
        },
    };
}

function makeFakeAlerts() {
    const calls = [];
    return { calls, async alert(level, text, opts) { calls.push({ level, text, opts }); return true; } };
}

const silentLogger = { child: () => silentLogger, info() {}, warn() {}, error() {} };

console.log('\n— outbox worker: envío exitoso —');

test('fila "text" exitosa: markSent + onSent se llaman; el puerto la manda', async () => {
    const store = makeFakeStore();
    const port = createFakePort({ groups: { '2v2': { id: 'chat-2v2' } } });
    await port.start();
    const alerts = makeFakeAlerts();
    const onSentCalls = [];

    const worker = createOutboxWorker({
        store, port, discord: makeFakeDiscord(), discord4v4: makeFakeDiscord(),
        alerts, logger: silentLogger,
        onSent: async (row) => { onSentCalls.push(row.id); },
    });

    const { id } = await store.enqueue({ kind: 'text', channel: 'whatsapp', payload: { chatId: 'chat-2v2', text: 'hola mundo' } });
    await worker.start();
    await worker.kick();

    assert.strictEqual(store.rows.find(r => r.id === id).status, 'sent');
    assert.strictEqual(port.sent.length, 1);
    assert.strictEqual(port.sent[0].text, 'hola mundo');
    assert.deepStrictEqual(onSentCalls, [id]);

    await worker.stop();
});

test('recoverStuck se llama UNA vez al arrancar, con ~2 minutos', async () => {
    const store = makeFakeStore();
    const port = createFakePort();
    const worker = createOutboxWorker({ store, port, discord: makeFakeDiscord(), discord4v4: makeFakeDiscord(), alerts: makeFakeAlerts(), logger: silentLogger });

    await worker.start();
    assert.strictEqual(store.calls.recoverStuck.length, 1);
    assert.strictEqual(store.calls.recoverStuck[0], 2 * 60 * 1000);
    await worker.stop();
});

console.log('\n— outbox worker: not_ready no cuenta intento —');

test('puerto no listo: SendError(not_ready) libera la fila SIN incrementar attempts', async () => {
    const store = makeFakeStore();
    const port = createFakePort({ groups: { '2v2': { id: 'chat-2v2' } } });
    // OJO: sin port.start() -> isReady() = false -> sendText lanza SendError('not_ready')
    const worker = createOutboxWorker({ store, port, discord: makeFakeDiscord(), discord4v4: makeFakeDiscord(), alerts: makeFakeAlerts(), logger: silentLogger });

    const { id } = await store.enqueue({ kind: 'text', channel: 'whatsapp', payload: { chatId: 'chat-2v2', text: 'hola' } });
    await worker.start();
    await worker.kick();

    const row = store.rows.find(r => r.id === id);
    assert.strictEqual(row.status, 'pending');
    assert.strictEqual(row.attempts, 0, 'not_ready no debe contar como intento');
    assert.strictEqual(store.calls.releaseNotReady.length, 1);
    assert.strictEqual(store.calls.markRetry.length, 0);

    await worker.stop();
});

test('kick() automático cuando el puerto emite status "ready"', async () => {
    const store = makeFakeStore();
    const port = createFakePort({ groups: { '2v2': { id: 'chat-2v2' } } });
    const worker = createOutboxWorker({ store, port, discord: makeFakeDiscord(), discord4v4: makeFakeDiscord(), alerts: makeFakeAlerts(), logger: silentLogger });

    const { id } = await store.enqueue({ kind: 'text', channel: 'whatsapp', payload: { chatId: 'chat-2v2', text: 'hola' } });
    await worker.start();
    await worker.kick(); // puerto no listo todavía -> releaseNotReady
    assert.strictEqual(store.rows.find(r => r.id === id).status, 'pending');

    await port.start(); // emite 'status' {state:'ready'} -> el worker debe re-intentar solo
    await worker.kick(); // encadena tras el tick disparado por el evento 'status'

    assert.strictEqual(store.rows.find(r => r.id === id).status, 'sent');
    await worker.stop();
});

console.log('\n— outbox worker: backoff y dead —');

test('backoff exponencial: 5s, 10s, 20s... en fallos sucesivos (transient)', async () => {
    const store = makeFakeStore();
    const port = createFakePort();
    const discord = makeFakeDiscord();
    discord.setShouldFail(true); // discord.sendImage siempre devuelve false -> transient
    let clock = 1_000_000;
    const worker = createOutboxWorker({
        store, port, discord, discord4v4: makeFakeDiscord(), alerts: makeFakeAlerts(), logger: silentLogger,
        maxAttempts: 10, now: () => clock,
    });

    const { id } = await store.enqueue({
        kind: 'game_image', channel: 'discord',
        payload: { gameId: 'g1', imagePath: '/tmp/x.png', gameData: {}, players: [] },
    });
    await worker.start();

    await worker.kick();
    assert.strictEqual(store.calls.markRetry[0].nextAttemptAt, clock + 5000);

    store.rows.find(r => r.id === id).next_attempt_at = 0; // forzar que vuelva a estar "vencida"
    await worker.kick();
    assert.strictEqual(store.calls.markRetry[1].nextAttemptAt, clock + 10000);

    store.rows.find(r => r.id === id).next_attempt_at = 0;
    await worker.kick();
    assert.strictEqual(store.calls.markRetry[2].nextAttemptAt, clock + 20000);

    await worker.stop();
});

test('permanent o intentos agotados -> dead + alerta (key outbox:dead)', async () => {
    const store = makeFakeStore();
    const port = createFakePort();
    const discord = makeFakeDiscord();
    discord.setShouldFail(true);
    const alerts = makeFakeAlerts();
    const worker = createOutboxWorker({ store, port, discord, discord4v4: makeFakeDiscord(), alerts, logger: silentLogger, maxAttempts: 2 });

    const { id } = await store.enqueue({
        kind: 'game_image', channel: 'discord',
        payload: { gameId: 'g1', imagePath: '/tmp/x.png', gameData: {}, players: [] },
    });
    await worker.start();

    await worker.kick(); // intento 1/2 -> retry
    assert.strictEqual(store.rows.find(r => r.id === id).status, 'pending');

    store.rows.find(r => r.id === id).next_attempt_at = 0;
    await worker.kick(); // intento 2/2 -> dead

    const row = store.rows.find(r => r.id === id);
    assert.strictEqual(row.status, 'dead');
    assert.strictEqual(store.calls.markDead.length, 1);
    assert.strictEqual(alerts.calls.length, 1);
    assert.strictEqual(alerts.calls[0].opts.key, 'outbox:dead');

    await worker.stop();
});

console.log('\n— outbox worker: round_update calcula el texto al enviar —');

test('round_update llama getRoundUpdateText AL MOMENTO DE ENVIAR, no al encolar', async () => {
    const store = makeFakeStore();
    const port = createFakePort({ groups: { '2v2': { id: 'chat-2v2' } } });
    await port.start();
    let currentText = 'texto viejo';
    const worker = createOutboxWorker({
        store, port, discord: makeFakeDiscord(), discord4v4: makeFakeDiscord(), alerts: makeFakeAlerts(), logger: silentLogger,
        getRoundUpdateText: async () => currentText,
    });

    await store.enqueue({ kind: 'round_update', channel: 'whatsapp', payload: { format: '2v2' } });
    currentText = 'texto nuevo (calculado al enviar)'; // cambia DESPUÉS de encolar
    await worker.start();
    await worker.kick();

    assert.strictEqual(port.sent[0].text, 'texto nuevo (calculado al enviar)');
    await worker.stop();
});

test('round_update sin nada que anunciar (texto falsy) se marca sent sin mandar nada', async () => {
    const store = makeFakeStore();
    const port = createFakePort({ groups: { '2v2': { id: 'chat-2v2' } } });
    await port.start();
    const worker = createOutboxWorker({
        store, port, discord: makeFakeDiscord(), discord4v4: makeFakeDiscord(), alerts: makeFakeAlerts(), logger: silentLogger,
        getRoundUpdateText: async () => null,
    });

    const { id } = await store.enqueue({ kind: 'round_update', channel: 'whatsapp', payload: { format: '2v2' } });
    await worker.start();
    await worker.kick();

    assert.strictEqual(store.rows.find(r => r.id === id).status, 'sent');
    assert.strictEqual(port.sent.length, 0);
    await worker.stop();
});

console.log('\n— outbox worker: stop() —');

test('stop() detiene el polling (kick() tras stop no hace nada)', async () => {
    const store = makeFakeStore();
    const port = createFakePort({ groups: { '2v2': { id: 'chat-2v2' } } });
    await port.start();
    const worker = createOutboxWorker({ store, port, discord: makeFakeDiscord(), discord4v4: makeFakeDiscord(), alerts: makeFakeAlerts(), logger: silentLogger });

    await worker.start();
    await worker.stop();

    const { id } = await store.enqueue({ kind: 'text', channel: 'whatsapp', payload: { chatId: 'chat-2v2', text: 'hola' } });
    await worker.kick();
    assert.strictEqual(store.rows.find(r => r.id === id).status, 'pending', 'tras stop(), kick() no debe procesar nada');
});
