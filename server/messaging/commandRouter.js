/**
 * Router de comandos de grupo, genérico sobre cualquier MessagingPort
 * (Fase A3). Reglas de despacho:
 *
 *  - El cuerpo del mensaje debe empezar con "!".
 *  - La primera palabra debe calzar EXACTO (case-insensitive) con un
 *    trigger registrado; el resto del texto es `args`.
 *  - Los mensajes `fromMe` SÍ se procesan (el bot puede correr comandos
 *    desde el propio teléfono admin — como hacía whatsapp-web.js).
 *  - Un mensaje cuyo id ya fue mandado por este router como respuesta se
 *    ignora (eco de la propia respuesta).
 *  - Un mensaje más viejo que `maxAgeSec` se ignora SIN correr el handler:
 *    un reconexión que reproduce el historial no debe disparar un
 *    "!rondas reset" de hace una hora.
 *
 * El handler recibe un `ctx` (ver JSDoc de `registerCommand`) y devuelve
 * `string | { text, mentions } | falsy` (falsy = no responder). La
 * respuesta se manda con `port.sendText`, con 3 intentos en memoria.
 */

'use strict';

const { identityKeys, sameIdentity } = require('./jid');

const DEFAULT_MAX_AGE_S = 120;
const OWN_SENT_CAP = 500;
const SEND_RETRIES = 3;

const noopLogger = { info() {}, warn() {}, error() {}, debug() {} };

/**
 * @param {import('./port').MessagingPort} port
 * @param {object} [opts]
 * @param {number} [opts.maxAgeSec=120] - mensajes más viejos se ignoran (0 = sin límite)
 * @param {{info:function,warn:function,error:function}} [opts.logger]
 * @param {(identity: import('./jid').Identity, msg: object) => (boolean|Promise<boolean>)} [opts.isAdmin]
 *   Resolución de admin, inyectada por quien arma el router (el server real
 *   la conecta a commands/admin.js; el default siempre dice que no).
 * @returns {{ registerCommand: (trigger: string, handler: function) => void }}
 */
function createCommandRouter(port, opts = {}) {
    const {
        maxAgeSec = DEFAULT_MAX_AGE_S,
        logger = noopLogger,
        isAdmin = async () => false,
    } = opts;

    const handlers = new Map(); // trigger (lowercase) -> handler
    const ownSentIds = new Set(); // ids de respuestas mandadas por este router

    function rememberOwnSent(id) {
        if (!id) return;
        ownSentIds.add(id);
        if (ownSentIds.size > OWN_SENT_CAP) {
            ownSentIds.delete(ownSentIds.values().next().value);
        }
    }

    /**
     * Registra un comando.
     * @param {string} trigger - p.ej. "!rondas"
     * @param {(ctx: {
     *   format: string|null,
     *   args: string,
     *   text: string,
     *   sender: import('./jid').Identity,
     *   senderKeys: string[],
     *   fromMe: boolean,
     *   mentions: import('./jid').Identity[],
     *   msg: object,
     *   port: import('./port').MessagingPort,
     *   isAdmin: () => Promise<boolean>,
     *   isSelf: (identity: import('./jid').Identity) => boolean,
     * }) => (string|{text:string, mentions?:string[]}|null|undefined|false)} handler
     */
    function registerCommand(trigger, handler) {
        if (!trigger || typeof handler !== 'function') return;
        handlers.set(String(trigger).toLowerCase(), handler);
    }

    async function sendReplyWithRetries(chatId, text, mentions) {
        const sendOpts = mentions && mentions.length ? { mentions } : undefined;
        for (let attempt = 1; attempt <= SEND_RETRIES; attempt++) {
            try {
                const sent = await port.sendText(chatId, text, sendOpts);
                if (sent && sent.id) rememberOwnSent(sent.id);
                return true;
            } catch (err) {
                if (attempt >= SEND_RETRIES) {
                    logger.error({ err }, '❌ commandRouter: no se pudo enviar la respuesta tras varios intentos');
                    return false;
                }
            }
        }
        return false;
    }

    async function handleIncoming(msg) {
        if (!msg || typeof msg.text !== 'string') return;
        const body = msg.text.trim();
        if (!body.startsWith('!')) return;

        const firstWord = body.split(/\s+/)[0].toLowerCase();
        const handler = handlers.get(firstWord);
        if (!handler) return;

        if (msg.id && ownSentIds.has(msg.id)) return; // eco de una respuesta propia

        if (maxAgeSec > 0 && Number.isFinite(msg.timestamp)) {
            const ageMs = Date.now() - msg.timestamp;
            if (ageMs > maxAgeSec * 1000) {
                logger.warn(`⏱️  commandRouter: '${firstWord}' descartado por antigüedad (${Math.round(ageMs / 1000)}s)`);
                return;
            }
        }

        const args = body.slice(firstWord.length).trim();
        const sender = msg.sender || {};
        const ctx = {
            format: msg.format ?? null,
            args,
            text: body,
            sender,
            senderKeys: identityKeys(sender),
            fromMe: !!msg.fromMe,
            mentions: msg.mentions || [],
            msg,
            port,
            isAdmin: async () => Boolean(await isAdmin(sender, msg)),
            isSelf: identity => sameIdentity(identity, typeof port.getSelfIdentity === 'function' ? port.getSelfIdentity() : null),
        };

        let reply;
        try {
            reply = await handler(ctx);
        } catch (err) {
            logger.error({ err }, `❌ commandRouter: handler de '${firstWord}' lanzó un error`);
            return;
        }
        if (!reply) return;

        const text = typeof reply === 'string' ? reply : reply.text;
        if (!text) return;
        const mentions = (typeof reply === 'object' && Array.isArray(reply.mentions)) ? reply.mentions : undefined;

        await sendReplyWithRetries(msg.chatId, text, mentions);
    }

    port.on('message', msg => {
        handleIncoming(msg).catch(err => logger.error({ err }, '❌ commandRouter: error inesperado despachando mensaje'));
    });

    return { registerCommand };
}

module.exports = { createCommandRouter, DEFAULT_MAX_AGE_S };
