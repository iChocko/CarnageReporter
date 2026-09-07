/**
 * Worker del outbox (Fase A4 — "guardar primero + outbox persistente").
 *
 * Hace polling de `store.claimDue()` cada `pollMs` (y de inmediato con
 * `kick()`, p.ej. cuando el pipeline acaba de encolar algo o WhatsApp acaba
 * de quedar 'ready') y despacha cada fila al canal que le toca:
 *
 *   - kind 'game_image', channel 'discord'|'discord4v4' -> discord(4v4).sendImage(imagePath, gameData, players)
 *   - kind 'game_image', channel 'whatsapp'              -> port.sendImage(chatId, {path, caption})
 *   - kind 'round_update', channel 'whatsapp'            -> texto se calcula AQUÍ (getRoundUpdateText), no al encolar
 *   - kind 'text', channel 'whatsapp'                    -> port.sendText(chatId, text, {mentions})
 *
 * Los polls (y sus envíos) corren en serie (un solo "tick" a la vez): con
 * `claimDue({limitPerChannel:1})` eso ya garantiza como mucho un envío en
 * vuelo por canal, sin necesitar locks aparte.
 *
 * Clasificación de errores (ver server/messaging/port.js#SendError):
 *   - 'not_ready'  -> NO cuenta como intento; la fila vuelve a 'pending' tal
 *                     cual, para el siguiente poll/kick (p.ej. cuando el
 *                     puerto emita 'status' en 'ready').
 *   - 'permanent'  -> 'dead' de inmediato + alerta (key 'outbox:dead').
 *   - 'transient' (default, incluye errores sin `.code` y 'read_only')
 *                  -> reintenta con backoff `min(5s·2^intentos, 15min)`;
 *                     'dead' + alerta si ya se alcanzó `maxAttempts`.
 */

'use strict';

const { OutboxUnavailableError } = require('./outboxStore');

const DEFAULT_POLL_MS = 5000;
const DEFAULT_MAX_ATTEMPTS = 8;
const BASE_BACKOFF_MS = 5000;
const MAX_BACKOFF_MS = 15 * 60 * 1000;
const STOP_GRACE_MS = 10000;

/**
 * Backoff exponencial con tope: 5s, 10s, 20s, ... cap 15 min.
 * `attempts` es el número de intentos YA hechos (1 en la primera falla).
 */
function backoffMs(attempts) {
    return Math.min(BASE_BACKOFF_MS * Math.pow(2, attempts - 1), MAX_BACKOFF_MS);
}

/** Código de SendError normalizado; sin `.code` (o 'read_only') se trata como reintentable. */
function errorCode(err) {
    const code = err && err.code;
    if (code === 'not_ready' || code === 'permanent' || code === 'transient') return code;
    return 'transient';
}

/**
 * @param {object} opts
 * @param {object} opts.store - ver server/messaging/outboxStore.js
 * @param {import('./port').MessagingPort} opts.port - a.k.a. `whatsapp` en ctx
 * @param {{sendImage: function}} opts.discord - canal 2v2
 * @param {{sendImage: function}} opts.discord4v4 - canal 4v4
 * @param {{alert: function}} opts.alerts
 * @param {object} [opts.logger]
 * @param {number} [opts.pollMs]
 * @param {number} [opts.maxAttempts]
 * @param {() => number} [opts.now] - inyectable para tests
 * @param {(payload: object) => Promise<string|null>} [opts.getRoundUpdateText] -
 *   calcula el texto del marcador de ronda AL MOMENTO DE ENVIAR (no al
 *   encolar); null/'' = nada que anunciar (éxito trivial, no se manda nada).
 * @param {(row: object) => Promise<void>} [opts.onSent] - hook posterior a un
 *   envío CONFIRMADO (p.ej. el reset de saldos, ver domain/saldos.js).
 * @returns {{start: function, stop: function, kick: function}}
 */
function createOutboxWorker({
    store,
    port,
    discord,
    discord4v4,
    alerts,
    logger,
    pollMs = DEFAULT_POLL_MS,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    now = Date.now,
    getRoundUpdateText = async () => null,
    onSent = async () => {},
}) {
    const log = (logger && typeof logger.child === 'function') ? logger.child({ mod: 'outbox' }) : (logger || console);

    let started = false;
    let timer = null;
    let currentTick = Promise.resolve();
    let statusListener = null;

    /** Despacha una fila reclamada; regresa el providerMessageId (o null) o lanza. */
    async function dispatch(row) {
        const { kind, channel, payload = {} } = row;

        if (kind === 'game_image') {
            if (channel === 'discord' || channel === 'discord4v4') {
                const svc = channel === 'discord' ? discord : discord4v4;
                const ok = await svc.sendImage(payload.imagePath, payload.gameData, payload.players);
                if (!ok) {
                    throw Object.assign(new Error(`Discord (${channel}) sendImage devolvió false`), { code: 'transient' });
                }
                return null;
            }
            if (channel === 'whatsapp') {
                const chatId = port.groupIdFor(payload.format);
                if (!chatId) return null; // sin grupo configurado para el formato: nada que hacer
                const { id } = await port.sendImage(chatId, {
                    path: payload.imagePath,
                    caption: payload.caption,
                });
                return id;
            }
        }

        if (kind === 'round_update' && channel === 'whatsapp') {
            const chatId = port.groupIdFor(payload.format);
            if (!chatId) return null;
            const text = await getRoundUpdateText(payload);
            if (!text) return null; // nada que anunciar ahora mismo: éxito trivial
            const { id } = await port.sendText(chatId, text);
            return id;
        }

        if (kind === 'text' && channel === 'whatsapp') {
            const chatId = payload.chatId || (payload.format ? port.groupIdFor(payload.format) : null);
            if (!chatId) {
                throw Object.assign(new Error('outbox: fila "text" sin chatId/format resoluble'), { code: 'permanent' });
            }
            const opts = {};
            if (Array.isArray(payload.mentions) && payload.mentions.length) opts.mentions = payload.mentions;
            const { id } = await port.sendText(chatId, payload.text, opts);
            return id;
        }

        throw Object.assign(
            new Error(`outbox: combinación kind/channel no soportada (${kind}/${channel})`),
            { code: 'permanent' }
        );
    }

    async function handleSendError(row, err) {
        const code = errorCode(err);

        if (code === 'not_ready') {
            log.info?.(`⏳ outbox: fila ${row.id} (${row.kind}/${row.channel}) — transporte no listo, se reintenta sin contar intento`);
            await store.releaseNotReady(row.id);
            return;
        }

        const nextAttempts = (row.attempts || 0) + 1;
        if (code === 'permanent' || nextAttempts >= maxAttempts) {
            log.error?.({ err, rowId: row.id }, `❌ outbox: fila ${row.id} (${row.kind}/${row.channel}) -> dead tras ${nextAttempts} intento(s)`);
            await store.markDead(row.id, err);
            await alerts.alert('error',
                `Outbox: fila ${row.id} (${row.kind}/${row.channel}) quedó DEAD tras ${nextAttempts} intento(s): ${err.message}`,
                { key: 'outbox:dead' });
            return;
        }

        const delay = backoffMs(nextAttempts);
        log.warn?.({ err, rowId: row.id }, `⚠️  outbox: fila ${row.id} (${row.kind}/${row.channel}) falló (intento ${nextAttempts}/${maxAttempts}); reintenta en ${Math.round(delay / 1000)}s`);
        await store.markRetry(row.id, { error: err, nextAttemptAt: now() + delay });
    }

    async function sendRow(row) {
        try {
            const providerMessageId = await dispatch(row);
            await store.markSent(row.id, providerMessageId);
            try {
                await onSent(row);
            } catch (err) {
                log.warn?.({ err, rowId: row.id }, '⚠️  outbox: onSent falló (el envío ya se había confirmado)');
            }
        } catch (err) {
            await handleSendError(row, err);
        }
    }

    /** Un poll: reclama lo que haya vencido (máx. 1 por canal) y lo procesa EN SERIE con el resto del tick. */
    async function runTick() {
        try {
            const rows = await store.claimDue({ limitPerChannel: 1 });
            if (rows.length) {
                await Promise.all(rows.map(row => sendRow(row)));
            }
        } catch (err) {
            if (err instanceof OutboxUnavailableError) {
                log.error?.({ err }, '❌ outbox: tabla no disponible');
                await alerts.alert('error',
                    `Outbox no disponible (¿falta aplicar la migración A4?): ${err.message}`,
                    { key: 'outbox:unavailable' });
            } else {
                log.error?.({ err }, '❌ outbox: claimDue falló');
            }
        }
    }

    function scheduleLoop() {
        if (!started) return;
        timer = setTimeout(() => { kick(); }, pollMs);
        timer.unref?.(); // no debe mantener vivo el proceso por sí solo (ni los tests)
    }

    /**
     * Dispara un tick ya mismo (encadenado tras el que esté en curso, nunca
     * en paralelo). Devuelve la promesa del tick para que los tests puedan
     * esperar a que termine (encolar + enviar + actualizar el store).
     */
    function kick() {
        if (!started) return currentTick;
        if (timer) { clearTimeout(timer); timer = null; }
        currentTick = currentTick.then(runTick, runTick).finally(scheduleLoop);
        return currentTick;
    }

    async function start() {
        if (started) return;
        started = true;
        try {
            await store.recoverStuck(2 * 60 * 1000);
        } catch (err) {
            if (!(err instanceof OutboxUnavailableError)) {
                log.warn?.({ err }, '⚠️  outbox: recoverStuck falló al arrancar');
            }
        }
        if (port && typeof port.on === 'function') {
            statusListener = (status) => { if (status?.state === 'ready') kick(); };
            port.on('status', statusListener);
        }
        // No dispara un tick de inmediato: arma el polling periódico. Un
        // backlog pendiente se procesa en el primer poll (pollMs) o, antes,
        // en cuanto algo llame kick() (el pipeline al encolar, o el puerto
        // al quedar 'ready').
        scheduleLoop();
    }

    /** Deja que el tick en curso termine (tope STOP_GRACE_MS) antes de cortar el polling. */
    async function stop() {
        if (!started) return;
        started = false;
        if (timer) { clearTimeout(timer); timer = null; }
        if (port && statusListener && typeof port.removeListener === 'function') {
            port.removeListener('status', statusListener);
        }
        statusListener = null;
        await new Promise((resolve) => {
            const deadline = setTimeout(resolve, STOP_GRACE_MS);
            deadline.unref?.();
            currentTick.catch(() => {}).finally(() => { clearTimeout(deadline); resolve(); });
        });
    }

    return { start, stop, kick };
}

module.exports = { createOutboxWorker };
