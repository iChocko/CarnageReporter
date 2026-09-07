/**
 * Outbox persistente (Fase A4 — "guardar primero + outbox persistente").
 *
 * `createOutboxStore(supabaseClient)` envuelve la tabla `outbox` (ver el
 * bloque "migración A4" en server/supabase_schema.sql — se aplica A MANO,
 * nada en el código la crea sola). Como la migración es manual, CUALQUIER
 * método puede lanzar `OutboxUnavailableError` si la tabla todavía no
 * existe; quien llame (server/messaging/outbox.js, server/report/pipeline.js,
 * server/domain/saldos.js) debe decidir el fallback (hoy: publicar directo).
 *
 * Filas: { id, kind, channel, target, dedupe_key, payload, status, attempts,
 * next_attempt_at, last_error, provider_message_id, acked_at, created_at,
 * sent_at }. `status`: 'pending' | 'sending' | 'sent' | 'dead'.
 */

'use strict';

/** Tabla `outbox` inexistente (migración A4 no aplicada todavía). */
class OutboxUnavailableError extends Error {
    constructor(message, { cause } = {}) {
        super(message);
        this.name = 'OutboxUnavailableError';
        if (cause) this.cause = cause;
    }
}

/** Postgres 42P01 = "undefined_table"; el mensaje también suele mencionar la tabla. */
function isMissingTableError(error) {
    if (!error) return false;
    if (error.code === '42P01') return true;
    const msg = String(error.message || '');
    return /outbox/i.test(msg) && /does not exist|no existe/i.test(msg);
}

/** Traduce un error de supabase-js: tabla faltante -> OutboxUnavailableError, si no, Error genérico. */
function mapError(error, context) {
    if (isMissingTableError(error)) {
        return new OutboxUnavailableError(
            `Tabla outbox no disponible (¿falta aplicar la migración A4?): ${error.message}`,
            { cause: error }
        );
    }
    return new Error(`outboxStore.${context}: ${error.message}`);
}

/**
 * @param {object|null} supabaseClient - cliente de supabase-js (o un fake con
 *   la misma forma encadenable: from().select()/.insert()/.upsert()/.update());
 *   `null` cuando Supabase no está configurado (SUPABASE_URL/KEY vacíos) —
 *   en ese caso CUALQUIER método lanza OutboxUnavailableError, igual que si
 *   la tabla no existiera, para que el fallback a publicación directa
 *   (server/messaging/outboxPublish.js) funcione sin distinguir el motivo.
 */
function createOutboxStore(supabaseClient) {
    const client = supabaseClient;

    if (!client) {
        const unavailable = async () => {
            throw new OutboxUnavailableError('Supabase no configurado: outbox no disponible');
        };
        return {
            enqueue: unavailable,
            claimDue: unavailable,
            markSent: unavailable,
            markRetry: unavailable,
            markDead: unavailable,
            releaseNotReady: unavailable,
            recoverStuck: unavailable,
            stats: unavailable,
            findSentByProviderId: unavailable,
        };
    }

    /**
     * Encola una fila. Si `row.dedupe_key` ya existe, NO la duplica: devuelve
     * el id de la fila existente (created:false) sin tocarla.
     * @param {{kind:string, channel:string, target?:string, dedupe_key?:string|null, payload:object}} row
     * @returns {Promise<{id:number|string, created:boolean}>}
     */
    async function enqueue(row) {
        const insertRow = {
            kind: row.kind,
            channel: row.channel,
            target: row.target ?? null,
            dedupe_key: row.dedupe_key ?? null,
            payload: row.payload ?? {},
            status: 'pending',
            attempts: 0,
            next_attempt_at: new Date().toISOString(),
        };

        if (!insertRow.dedupe_key) {
            const { data, error } = await client.from('outbox').insert(insertRow).select('id').single();
            if (error) throw mapError(error, 'enqueue');
            return { id: data.id, created: true };
        }

        const { data, error } = await client.from('outbox')
            .upsert(insertRow, { onConflict: 'dedupe_key', ignoreDuplicates: true })
            .select('id');
        if (error) throw mapError(error, 'enqueue');
        if (data && data.length) return { id: data[0].id, created: true };

        // ignoreDuplicates no regresa la fila existente: se busca aparte.
        const { data: existing, error: selErr } = await client.from('outbox')
            .select('id')
            .eq('dedupe_key', insertRow.dedupe_key)
            .single();
        if (selErr) throw mapError(selErr, 'enqueue');
        return { id: existing.id, created: false };
    }

    /**
     * Reclama hasta `limitPerChannel` filas 'pending' con `next_attempt_at` ya
     * vencido, por canal, FIFO por id, y las pasa a 'sending' (también les
     * refresca `next_attempt_at` a AHORA — sirve para que `recoverStuck` sepa
     * desde cuándo llevan "enviándose", sin necesitar una columna aparte).
     * @param {{limitPerChannel?: number, channels?: string[]}} [opts] -
     *   `channels`, si se da, restringe a esos canales (para no reclamar de
     *   canales que el worker ya tiene con un envío en curso).
     * @returns {Promise<Array<object>>}
     */
    async function claimDue({ limitPerChannel = 1, channels = null } = {}) {
        const nowIso = new Date().toISOString();
        let query = client.from('outbox')
            .select('*')
            .eq('status', 'pending')
            .lte('next_attempt_at', nowIso)
            .order('id', { ascending: true });
        if (Array.isArray(channels)) query = query.in('channel', channels);

        const { data, error } = await query;
        if (error) throw mapError(error, 'claimDue');

        const byChannel = new Map();
        const claimed = [];
        for (const row of data || []) {
            const list = byChannel.get(row.channel) || [];
            if (list.length >= limitPerChannel) continue;
            list.push(row);
            byChannel.set(row.channel, list);
            claimed.push(row);
        }
        if (!claimed.length) return [];

        const ids = claimed.map(r => r.id);
        const { error: updErr } = await client.from('outbox')
            .update({ status: 'sending', next_attempt_at: nowIso })
            .in('id', ids);
        if (updErr) throw mapError(updErr, 'claimDue');

        return claimed.map(r => ({ ...r, status: 'sending', next_attempt_at: nowIso }));
    }

    /** @returns {Promise<void>} */
    async function markSent(id, providerMessageId = null) {
        const nowIso = new Date().toISOString();
        const { error } = await client.from('outbox')
            .update({ status: 'sent', provider_message_id: providerMessageId ?? null, sent_at: nowIso })
            .eq('id', id);
        if (error) throw mapError(error, 'markSent');
    }

    /**
     * Fallo reintentable: incrementa `attempts` y programa `next_attempt_at`.
     * @param {{error: Error|string, nextAttemptAt: number|Date|string}} opts
     * @returns {Promise<{attempts:number}>}
     */
    async function markRetry(id, { error, nextAttemptAt }) {
        const { data: current, error: selErr } = await client.from('outbox')
            .select('attempts').eq('id', id).single();
        if (selErr) throw mapError(selErr, 'markRetry');

        const attempts = (current?.attempts || 0) + 1;
        const { error: updErr } = await client.from('outbox')
            .update({
                status: 'pending',
                attempts,
                last_error: String((error && error.message) || error || ''),
                next_attempt_at: new Date(nextAttemptAt).toISOString(),
            })
            .eq('id', id);
        if (updErr) throw mapError(updErr, 'markRetry');
        return { attempts };
    }

    /** Fallo NO reintentable (permanente, o se agotaron los intentos). */
    async function markDead(id, error) {
        const { error: updErr } = await client.from('outbox')
            .update({ status: 'dead', last_error: String((error && error.message) || error || '') })
            .eq('id', id);
        if (updErr) throw mapError(updErr, 'markDead');
    }

    /**
     * Fallo `not_ready`: NO cuenta como intento (backoff/attempts intactos),
     * solo regresa la fila a 'pending' para que el siguiente poll/kick la
     * vuelva a intentar.
     */
    async function releaseNotReady(id) {
        const { error } = await client.from('outbox').update({ status: 'pending' }).eq('id', id);
        if (error) throw mapError(error, 'releaseNotReady');
    }

    /** 'sending' -> 'pending' para filas que llevan más de `olderThanMs` así (worker que murió a medio envío). */
    async function recoverStuck(olderThanMs) {
        const cutoffIso = new Date(Date.now() - olderThanMs).toISOString();
        const nowIso = new Date().toISOString();
        const { data, error } = await client.from('outbox')
            .select('id')
            .eq('status', 'sending')
            .lte('next_attempt_at', cutoffIso);
        if (error) throw mapError(error, 'recoverStuck');
        const ids = (data || []).map(r => r.id);
        if (!ids.length) return { recovered: 0 };

        const { error: updErr } = await client.from('outbox')
            .update({ status: 'pending', next_attempt_at: nowIso })
            .in('id', ids);
        if (updErr) throw mapError(updErr, 'recoverStuck');
        return { recovered: ids.length };
    }

    /** @returns {Promise<{pending:number, dead:number, oldestPendingSec:number|null}>} */
    async function stats() {
        const { count: pending, error: pErr } = await client.from('outbox')
            .select('id', { count: 'exact', head: true }).eq('status', 'pending');
        if (pErr) throw mapError(pErr, 'stats');

        const { count: dead, error: dErr } = await client.from('outbox')
            .select('id', { count: 'exact', head: true }).eq('status', 'dead');
        if (dErr) throw mapError(dErr, 'stats');

        const { data: oldest, error: oErr } = await client.from('outbox')
            .select('created_at').eq('status', 'pending')
            .order('created_at', { ascending: true }).limit(1);
        if (oErr) throw mapError(oErr, 'stats');

        let oldestPendingSec = null;
        if (oldest && oldest.length) {
            oldestPendingSec = Math.max(0, Math.round((Date.now() - new Date(oldest[0].created_at).getTime()) / 1000));
        }

        return { pending: pending || 0, dead: dead || 0, oldestPendingSec };
    }

    /** Fila 'sent' con este provider_message_id, o null. Para deduplicar acks entrantes. */
    async function findSentByProviderId(providerMessageId) {
        const { data, error } = await client.from('outbox')
            .select('*').eq('provider_message_id', providerMessageId).eq('status', 'sent').limit(1);
        if (error) throw mapError(error, 'findSentByProviderId');
        return (data && data[0]) || null;
    }

    return {
        enqueue,
        claimDue,
        markSent,
        markRetry,
        markDead,
        releaseNotReady,
        recoverStuck,
        stats,
        findSentByProviderId,
    };
}

module.exports = { createOutboxStore, OutboxUnavailableError, isMissingTableError };
