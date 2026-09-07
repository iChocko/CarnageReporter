/**
 * Corte semanal de saldos (Fase A2 — movido tal cual desde index.js, salvo
 * que ahora recibe `ctx` en vez de cerrar sobre variables de módulo).
 */

'use strict';

const rosterStore = require('../utils/roster');
const { identityFromKeys, toLegacyJid } = require('../messaging/jid');
const { computeSaldos, formatSaldosMessage, getLastCorteTs, setLastCorteTs, isSameCdmxDay } = require('../utils/saldos');
const { setResetTs } = require('../utils/rondasReset');
const { getSaldosGames } = require('./rondas');
const { enqueueOrDirect } = require('../messaging/outboxPublish');

/**
 * Corte semanal de saldos: arma el mensaje con las deudas netas por
 * alineación desde el último reset, con menciones desde el roster.
 * @returns {Promise<{payload: {text: string, mentions: string[]}|null, gamesCount: number}>}
 */
async function buildSaldosPayload(ctx) {
    const games = await getSaldosGames(ctx);
    const saldos = computeSaldos(games);

    const data = rosterStore.loadRoster(ctx.outputDir);
    const jidByTagLower = new Map();
    for (const link of data.links) {
        const jid = toLegacyJid(identityFromKeys(link.ids));
        if (jid) jidByTagLower.set(link.gamertag.toLowerCase(), jid);
    }

    return { payload: formatSaldosMessage(saldos, games.length, jidByTagLower), gamesCount: games.length };
}

/**
 * Efecto posterior a un corte de saldos ya CONFIRMADO como enviado: reinicia
 * el marcador de rondas y el de corte diario (invariante que NO cambia con
 * el outbox — Fase A4: solo corre tras la confirmación, sea inmediata con el
 * outbox apagado, o diferida vía el hook `onSent` del worker cuando está
 * encendido; ver server/context.js, que reconoce estas filas por
 * `payload.meta.action === 'saldos_cut'`).
 * @param {{outputDir: string, gamesCache: {invalidateAll: function}}} ctx
 * @param {{cutTs: number, skipReset?: boolean}} meta
 */
async function applySaldosSentSideEffects(ctx, { cutTs, skipReset = false } = {}) {
    if (skipReset) return;
    setResetTs(ctx.outputDir, cutTs);
    setLastCorteTs(ctx.outputDir, cutTs);
    ctx.gamesCache.invalidateAll();
}

/** Envío directo del corte (outbox apagado, o fallback si la tabla no está disponible). */
async function sendSaldosDirect(ctx, { payload, chatId, cutTs, skipReset, gamesCount }) {
    // waitUntilMsgSent: esperar la confirmación del servidor de WhatsApp,
    // no solo el encolado local — el reset borra deudas y exige certeza.
    const options = { waitUntilMsgSent: true };
    if (payload.mentions.length) options.mentions = payload.mentions;
    const ok = await ctx.whatsapp.sendMessage(payload.text, chatId, options);
    if (ok && skipReset) return { sent: true, reset: false, skipped: true, gamesCount };
    if (ok) await applySaldosSentSideEffects(ctx, { cutTs, skipReset });
    return { sent: ok, reset: ok, gamesCount };
}

/**
 * Job de los lunes: manda los saldos al grupo 2v2 y, SOLO si el mensaje se
 * confirmó enviado, reinicia el marcador. El cron reintenta cada hora hasta
 * las 23:00 por si el servidor estaba reiniciando a las 09:00; el marcador
 * de corte diario evita repetirlo una vez hecho. Si WhatsApp está caído las
 * deudas no se pierden (sin reset); POST .../send-saldos lo corre a mano.
 *
 * Con OUTBOX_ENABLED (Fase A4): se encola (dedupe_key `saldos:<cutTs>`, así
 * que reintentar el mismo corte no lo duplica) en vez de mandarlo aquí
 * mismo, y la confirmación (+ el reset) los hace el outbox worker cuando de
 * verdad se entregue — por eso NO se exige `whatsapp.isReady()` para
 * encolar. Si la tabla `outbox` no existe todavía, cae a envío directo
 * (mismo camino que con el outbox apagado).
 * @param {{force?: boolean, skipReset?: boolean}} [opts] - force salta el
 *   guard de "ya corrido hoy"; skipReset manda el mensaje real pero NO
 *   toca el marcador de rondas ni el de corte diario (para probar en vivo
 *   sin adelantar el corte de la semana).
 */
async function sendWeeklySaldos(ctx, { force = false, skipReset = false } = {}) {
    return ctx.locks.withSaldosLock(async () => {
        const last = getLastCorteTs(ctx.outputDir);
        if (!force && !skipReset && last && isSameCdmxDay(last, Date.now())) {
            return { sent: false, reason: 'corte_ya_hecho_hoy' };
        }

        // El corte se fija ANTES de leer las partidas: lo que caiga durante
        // el envío no se anuncia hoy, pero queda pendiente para el próximo
        // corte en lugar de borrarse sin haberse anunciado.
        const cutTs = Date.now();
        const { payload, gamesCount } = await buildSaldosPayload(ctx);
        if (!payload) {
            if (!skipReset) setLastCorteTs(ctx.outputDir, cutTs); // semana sin retas: corte trivial
            return { sent: false, reason: 'sin_retas_pendientes', gamesCount };
        }

        const outboxEnabled = !!(ctx.config?.OUTBOX_ENABLED && ctx.outboxStore);
        if (!outboxEnabled && !ctx.whatsapp.isReady()) {
            return { sent: false, reason: 'whatsapp_no_listo', gamesCount };
        }
        const chatId = ctx.whatsapp.groupIdFor('2v2');
        if (!chatId) return { sent: false, reason: 'sin_grupo_2v2', gamesCount };

        if (outboxEnabled) {
            const result = await enqueueOrDirect(ctx, {
                kind: 'text', channel: 'whatsapp', target: chatId,
                dedupe_key: `saldos:${cutTs}`,
                payload: {
                    text: payload.text,
                    chatId,
                    mentions: payload.mentions.length ? payload.mentions : undefined,
                    meta: { action: 'saldos_cut', cutTs, skipReset },
                },
            }, () => sendSaldosDirect(ctx, { payload, chatId, cutTs, skipReset, gamesCount }));
            if (result.queued) return { queued: true, id: result.id, gamesCount };
            return result; // fallback directo (outbox no disponible): mismo shape que abajo
        }

        return sendSaldosDirect(ctx, { payload, chatId, cutTs, skipReset, gamesCount });
    });
}

module.exports = { buildSaldosPayload, sendWeeklySaldos, applySaldosSentSideEffects, sendSaldosDirect };
