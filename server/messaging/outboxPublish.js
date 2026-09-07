/**
 * Helper compartido (Fase A4) para los puntos que publican por outbox cuando
 * está habilitado (report/pipeline.js, domain/saldos.js, adminWhatsapp.js,
 * adminGames.js#republish): encola la fila y, si la tabla `outbox` todavía
 * no existe (migración A4 no aplicada — `OutboxUnavailableError`), alerta
 * UNA vez (key 'outbox:unavailable', dedupe de server/alerts.js) y cae a
 * `directSend()` para que el reporte/mensaje no se pierda mientras el
 * operador aplica la migración.
 *
 * Con `ctx.config.OUTBOX_ENABLED` apagado (o sin `ctx.outboxStore`), llama
 * `directSend()` directo, sin tocar el outbox.
 */

'use strict';

const { OutboxUnavailableError } = require('./outboxStore');

/**
 * @param {{config: object, outboxStore?: object, outboxWorker?: object, alerts: {alert: function}, logger?: object}} ctx
 * @param {{kind: string, channel: string, target?: string, dedupe_key?: string|null, payload: object}} row
 * @param {() => Promise<any>} directSend - fallback (o comportamiento normal si el outbox está apagado)
 * @returns {Promise<{queued: true, id: any}|any>} - `{queued:true, id}` si se encoló; si no, lo que devuelva `directSend()`
 */
async function enqueueOrDirect(ctx, row, directSend) {
    if (ctx?.config?.OUTBOX_ENABLED && ctx.outboxStore) {
        try {
            const { id } = await ctx.outboxStore.enqueue(row);
            ctx.outboxWorker?.kick();
            return { queued: true, id };
        } catch (err) {
            if (err instanceof OutboxUnavailableError) {
                const log = ctx.logger?.child ? ctx.logger.child({ mod: 'outbox' }) : ctx.logger;
                log?.error?.({ err }, '❌ Outbox no disponible, fallback a publicación directa');
                await ctx.alerts.alert('error',
                    `Outbox no disponible (¿falta aplicar la migración A4?): ${err.message}. Publicando directo mientras tanto.`,
                    { key: 'outbox:unavailable' });
            } else {
                throw err;
            }
        }
    }
    return directSend();
}

/**
 * Como `enqueueOrDirect`, pero normaliza el resultado a un status corto
 * ('queued' si se encoló; lo que devuelva `directSend()` si no) — usado por
 * report/pipeline.js y el republish de adminGames.js para armar el objeto
 * `publish` de la respuesta.
 * @returns {Promise<string>}
 */
async function publishRow(ctx, row, directSend) {
    const result = await enqueueOrDirect(ctx, row, directSend);
    return (result && result.queued) ? 'queued' : result;
}

module.exports = { enqueueOrDirect, publishRow };
