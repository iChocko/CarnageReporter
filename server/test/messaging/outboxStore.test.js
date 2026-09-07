/**
 * Tests de server/messaging/outboxStore.js con un cliente Supabase fake en
 * memoria (sin red): dedupe al encolar, FIFO/limitPerChannel de claimDue,
 * transiciones de estado (sent/retry/dead/releaseNotReady), recoverStuck,
 * stats() y la detección de tabla faltante (OutboxUnavailableError).
 */

'use strict';

const { test } = require('node:test');
const assert = require('assert');

const { createOutboxStore, OutboxUnavailableError } = require('../../messaging/outboxStore');

/**
 * Cliente Supabase-js fake: soporta exactamente las cadenas que usa
 * outboxStore.js (select/insert/upsert/update + eq/lte/in/order/limit +
 * single(), o await directo sobre el builder). Una sola tabla en memoria.
 */
function makeFakeSupabaseClient({ failWith = null } = {}) {
    let rows = [];
    let nextId = 1;

    function applyFilters(list, filters) {
        return list.filter(row => filters.every(f => {
            const v = row[f.field];
            if (f.op === 'eq') return v === f.value;
            if (f.op === 'lte') return v <= f.value;
            if (f.op === 'in') return f.value.includes(v);
            return true;
        }));
    }

    function makeBuilder() {
        const filters = [];
        let mode = null;
        let selectCount = null;
        let insertData = null;
        let upsertData = null;
        let upsertOpts = null;
        let updateData = null;
        let orderField = null;
        let orderAsc = true;
        let limitN = null;
        let singleMode = false;

        async function execute() {
            if (failWith) return singleMode ? { data: null, error: failWith } : { data: null, error: failWith };

            if (mode === 'insert') {
                const row = { id: nextId++, created_at: new Date().toISOString(), attempts: 0, ...insertData };
                rows.push(row);
                return finish([row]);
            }
            if (mode === 'upsert') {
                const key = upsertOpts?.onConflict;
                const idx = key ? rows.findIndex(r => r[key] != null && r[key] === upsertData[key]) : -1;
                if (idx >= 0) {
                    if (upsertOpts?.ignoreDuplicates) return finish([]);
                    rows[idx] = { ...rows[idx], ...upsertData };
                    return finish([rows[idx]]);
                }
                const row = { id: nextId++, created_at: new Date().toISOString(), attempts: 0, ...upsertData };
                rows.push(row);
                return finish([row]);
            }
            if (mode === 'update') {
                const matched = applyFilters(rows, filters);
                for (const row of matched) Object.assign(row, updateData);
                return finish(matched);
            }
            // select
            let result = applyFilters(rows, filters);
            if (orderField) {
                result = [...result].sort((a, b) => {
                    const av = a[orderField];
                    const bv = b[orderField];
                    if (av < bv) return orderAsc ? -1 : 1;
                    if (av > bv) return orderAsc ? 1 : -1;
                    return 0;
                });
            }
            if (limitN != null) result = result.slice(0, limitN);
            if (selectCount) return { count: applyFilters(rows, filters).length, error: null };
            return finish(result);
        }

        function finish(list) {
            if (singleMode) {
                if (!list.length) return { data: null, error: { message: 'no rows', code: 'PGRST116' } };
                return { data: list[0], error: null };
            }
            return { data: list, error: null };
        }

        const builder = {
            select(_cols, opts) {
                mode = mode || 'select';
                if (opts && opts.count) selectCount = opts;
                return builder;
            },
            insert(data) { mode = 'insert'; insertData = data; return builder; },
            upsert(data, opts) { mode = 'upsert'; upsertData = data; upsertOpts = opts; return builder; },
            update(data) { mode = 'update'; updateData = data; return builder; },
            eq(field, value) { filters.push({ field, op: 'eq', value }); return builder; },
            lte(field, value) { filters.push({ field, op: 'lte', value }); return builder; },
            in(field, values) { filters.push({ field, op: 'in', value: values }); return builder; },
            order(field, { ascending = true } = {}) { orderField = field; orderAsc = ascending; return builder; },
            limit(n) { limitN = n; return builder; },
            single() { singleMode = true; return execute(); },
            then(resolve, reject) { execute().then(resolve, reject); },
        };
        return builder;
    }

    return { client: { from: () => makeBuilder() }, _rows: () => rows, _seed: (r) => { rows.push(r); } };
}

function seedRow(fake, overrides = {}) {
    const row = {
        id: overrides.id ?? fake._rows().length + 1,
        kind: 'text',
        channel: 'whatsapp',
        target: null,
        dedupe_key: null,
        payload: {},
        status: 'pending',
        attempts: 0,
        next_attempt_at: new Date(0).toISOString(),
        last_error: null,
        provider_message_id: null,
        acked_at: null,
        created_at: new Date().toISOString(),
        sent_at: null,
        ...overrides,
    };
    fake._seed(row);
    return row;
}

console.log('\n— outboxStore: enqueue —');

test('enqueue sin dedupe_key siempre inserta una fila nueva', async () => {
    const fake = makeFakeSupabaseClient();
    const store = createOutboxStore(fake.client);

    const a = await store.enqueue({ kind: 'text', channel: 'whatsapp', payload: { text: 'a' } });
    const b = await store.enqueue({ kind: 'text', channel: 'whatsapp', payload: { text: 'b' } });
    assert.notStrictEqual(a.id, b.id);
    assert.strictEqual(a.created, true);
    assert.strictEqual(fake._rows().length, 2);
});

test('enqueue con el mismo dedupe_key no duplica: regresa el id existente', async () => {
    const fake = makeFakeSupabaseClient();
    const store = createOutboxStore(fake.client);

    const first = await store.enqueue({ kind: 'game_image', channel: 'discord', dedupe_key: 'game_image:discord:g1', payload: { gameId: 'g1' } });
    assert.strictEqual(first.created, true);

    const second = await store.enqueue({ kind: 'game_image', channel: 'discord', dedupe_key: 'game_image:discord:g1', payload: { gameId: 'g1' } });
    assert.strictEqual(second.created, false);
    assert.strictEqual(second.id, first.id);
    assert.strictEqual(fake._rows().length, 1, 'no debió insertar una segunda fila');
});

test('enqueue deja status=pending, attempts=0 y next_attempt_at <= ahora', async () => {
    const fake = makeFakeSupabaseClient();
    const store = createOutboxStore(fake.client);
    await store.enqueue({ kind: 'text', channel: 'whatsapp', payload: { text: 'x' } });

    const [row] = fake._rows();
    assert.strictEqual(row.status, 'pending');
    assert.strictEqual(row.attempts, 0);
    assert.ok(new Date(row.next_attempt_at).getTime() <= Date.now());
});

console.log('\n— outboxStore: claimDue —');

test('claimDue reclama FIFO por id y respeta limitPerChannel', async () => {
    const fake = makeFakeSupabaseClient();
    const store = createOutboxStore(fake.client);
    seedRow(fake, { id: 3, channel: 'discord' });
    seedRow(fake, { id: 1, channel: 'discord' });
    seedRow(fake, { id: 2, channel: 'discord' });

    const claimed = await store.claimDue({ limitPerChannel: 2 });
    assert.deepStrictEqual(claimed.map(r => r.id), [1, 2]);
    assert.ok(claimed.every(r => r.status === 'sending'));

    const stillPending = fake._rows().find(r => r.id === 3);
    assert.strictEqual(stillPending.status, 'pending');
});

test('claimDue ignora filas cuyo next_attempt_at aún no vence', async () => {
    const fake = makeFakeSupabaseClient();
    const store = createOutboxStore(fake.client);
    seedRow(fake, { id: 1, next_attempt_at: new Date(Date.now() + 60_000).toISOString() });
    seedRow(fake, { id: 2, next_attempt_at: new Date(0).toISOString() });

    const claimed = await store.claimDue({ limitPerChannel: 5 });
    assert.deepStrictEqual(claimed.map(r => r.id), [2]);
});

test('claimDue separa por canal: un canal lleno no bloquea a otro', async () => {
    const fake = makeFakeSupabaseClient();
    const store = createOutboxStore(fake.client);
    seedRow(fake, { id: 1, channel: 'discord' });
    seedRow(fake, { id: 2, channel: 'discord' });
    seedRow(fake, { id: 3, channel: 'whatsapp' });

    const claimed = await store.claimDue({ limitPerChannel: 1 });
    assert.deepStrictEqual(claimed.map(r => r.id).sort(), [1, 3]);
});

test('claimDue con `channels` restringe a esos canales (no reclama de uno ocupado)', async () => {
    const fake = makeFakeSupabaseClient();
    const store = createOutboxStore(fake.client);
    seedRow(fake, { id: 1, channel: 'discord' });
    seedRow(fake, { id: 2, channel: 'whatsapp' });

    const claimed = await store.claimDue({ limitPerChannel: 1, channels: ['whatsapp'] });
    assert.deepStrictEqual(claimed.map(r => r.id), [2]);
});

console.log('\n— outboxStore: transiciones de estado —');

test('markSent deja status=sent con el providerMessageId', async () => {
    const fake = makeFakeSupabaseClient();
    const store = createOutboxStore(fake.client);
    seedRow(fake, { id: 1 });

    await store.markSent(1, 'wa-123');
    const row = fake._rows()[0];
    assert.strictEqual(row.status, 'sent');
    assert.strictEqual(row.provider_message_id, 'wa-123');
    assert.ok(row.sent_at);
});

test('markRetry incrementa attempts, guarda last_error y agenda next_attempt_at', async () => {
    const fake = makeFakeSupabaseClient();
    const store = createOutboxStore(fake.client);
    seedRow(fake, { id: 1, attempts: 2 });

    const future = Date.now() + 30_000;
    const { attempts } = await store.markRetry(1, { error: new Error('boom'), nextAttemptAt: future });
    assert.strictEqual(attempts, 3);

    const row = fake._rows()[0];
    assert.strictEqual(row.status, 'pending');
    assert.strictEqual(row.attempts, 3);
    assert.strictEqual(row.last_error, 'boom');
    assert.strictEqual(new Date(row.next_attempt_at).getTime(), future);
});

test('markDead deja status=dead con el motivo', async () => {
    const fake = makeFakeSupabaseClient();
    const store = createOutboxStore(fake.client);
    seedRow(fake, { id: 1 });

    await store.markDead(1, new Error('definitivo'));
    const row = fake._rows()[0];
    assert.strictEqual(row.status, 'dead');
    assert.strictEqual(row.last_error, 'definitivo');
});

test('releaseNotReady regresa a pending SIN tocar attempts', async () => {
    const fake = makeFakeSupabaseClient();
    const store = createOutboxStore(fake.client);
    seedRow(fake, { id: 1, status: 'sending', attempts: 4 });

    await store.releaseNotReady(1);
    const row = fake._rows()[0];
    assert.strictEqual(row.status, 'pending');
    assert.strictEqual(row.attempts, 4, 'not_ready no debe contar como intento');
});

console.log('\n— outboxStore: recoverStuck —');

test('recoverStuck regresa a pending las filas "sending" más viejas que el umbral', async () => {
    const fake = makeFakeSupabaseClient();
    const store = createOutboxStore(fake.client);
    seedRow(fake, { id: 1, status: 'sending', next_attempt_at: new Date(Date.now() - 5 * 60_000).toISOString() });
    seedRow(fake, { id: 2, status: 'sending', next_attempt_at: new Date().toISOString() }); // recién reclamada, no está "atorada"
    seedRow(fake, { id: 3, status: 'pending' });

    const { recovered } = await store.recoverStuck(2 * 60 * 1000);
    assert.strictEqual(recovered, 1);
    assert.strictEqual(fake._rows().find(r => r.id === 1).status, 'pending');
    assert.strictEqual(fake._rows().find(r => r.id === 2).status, 'sending');
});

console.log('\n— outboxStore: stats —');

test('stats reporta pending/dead/oldestPendingSec', async () => {
    const fake = makeFakeSupabaseClient();
    const store = createOutboxStore(fake.client);
    const oldTs = new Date(Date.now() - 90_000).toISOString();
    seedRow(fake, { id: 1, status: 'pending', created_at: oldTs });
    seedRow(fake, { id: 2, status: 'pending', created_at: new Date().toISOString() });
    seedRow(fake, { id: 3, status: 'dead' });
    seedRow(fake, { id: 4, status: 'sent' });

    const stats = await store.stats();
    assert.strictEqual(stats.pending, 2);
    assert.strictEqual(stats.dead, 1);
    assert.ok(stats.oldestPendingSec >= 89 && stats.oldestPendingSec <= 100, stats.oldestPendingSec);
});

test('stats sin filas pendientes -> oldestPendingSec null', async () => {
    const fake = makeFakeSupabaseClient();
    const store = createOutboxStore(fake.client);
    const stats = await store.stats();
    assert.deepStrictEqual(stats, { pending: 0, dead: 0, oldestPendingSec: null });
});

console.log('\n— outboxStore: findSentByProviderId —');

test('findSentByProviderId encuentra la fila enviada; null si no existe', async () => {
    const fake = makeFakeSupabaseClient();
    const store = createOutboxStore(fake.client);
    seedRow(fake, { id: 1, status: 'sent', provider_message_id: 'wa-abc' });

    const found = await store.findSentByProviderId('wa-abc');
    assert.strictEqual(found.id, 1);

    const missing = await store.findSentByProviderId('no-existe');
    assert.strictEqual(missing, null);
});

console.log('\n— outboxStore: tabla faltante (migración A4 no aplicada) —');

test('cualquier método lanza OutboxUnavailableError si la tabla no existe (42P01)', async () => {
    const fake = makeFakeSupabaseClient({ failWith: { code: '42P01', message: 'relation "public.outbox" does not exist' } });
    const store = createOutboxStore(fake.client);

    await assert.rejects(() => store.enqueue({ kind: 'text', channel: 'whatsapp', payload: {} }), OutboxUnavailableError);
    await assert.rejects(() => store.claimDue({}), OutboxUnavailableError);
    await assert.rejects(() => store.stats(), OutboxUnavailableError);
});

test('cliente null (Supabase no configurado) -> OutboxUnavailableError en cualquier método', async () => {
    const store = createOutboxStore(null);
    await assert.rejects(() => store.enqueue({ kind: 'text', channel: 'whatsapp', payload: {} }), OutboxUnavailableError);
    await assert.rejects(() => store.stats(), OutboxUnavailableError);
});

test('un error de Supabase que NO es de tabla faltante se propaga como Error genérico', async () => {
    const fake = makeFakeSupabaseClient({ failWith: { message: 'timeout de red' } });
    const store = createOutboxStore(fake.client);

    await assert.rejects(() => store.enqueue({ kind: 'text', channel: 'whatsapp', payload: {} }),
        (err) => !(err instanceof OutboxUnavailableError) && /timeout de red/.test(err.message));
});
