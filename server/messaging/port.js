/**
 * MessagingPort (Fase A3): contrato transporte-neutral que separa el resto
 * del server (comandos, pipeline de reportes, jobs) de whatsapp-web.js.
 *
 * Hoy solo existe un transporte real (`adapters/wwebjs.js`), pero el punto
 * de este contrato es que mañana pueda existir otro (Baileys, Fase A5) sin
 * tocar un solo comando: todos programan contra `MessagingPort`, nunca
 * contra el cliente de whatsapp-web.js.
 *
 * ## Ciclo de vida y estado
 *
 * `getStatus().state` es una máquina de estados simple:
 *
 *   disabled -> starting -> waiting_pairing -> connecting -> ready
 *                                                  ^  |
 *                                                  |  v
 *                                            reconnecting
 *                     (o, en cualquier punto: logged_out | replaced | stopped)
 *
 * - `disabled`: el transporte está apagado por config; todo es no-op.
 * - `starting`: `start()` fue llamado, todavía no hay sesión.
 * - `waiting_pairing`: se necesita escanear un QR o capturar un pairing code
 *   (ver `getPairing()`); no hay envíos posibles.
 * - `connecting`: credenciales presentes, estableciendo la sesión.
 * - `ready`: se puede enviar y se reciben mensajes.
 * - `reconnecting`: se perdió la conexión y se está reintentando (backoff);
 *   puede volver a `ready` o cualquier estado anterior.
 * - `logged_out`: la sesión fue cerrada desde el otro lado (log out real);
 *   requiere volver a emparejar.
 * - `replaced`: otra sesión tomó el lugar de esta (multi-dispositivo).
 * - `stopped`: `stop()` fue llamado; el puerto no reintenta solo.
 *
 * ## Identidad
 *
 * Todo lo que identifica personas usa `Identity` (ver `./jid.js`):
 * `{ pn?: string, lid?: string }`, ambos solo dígitos. Los adaptadores
 * traducen su formato nativo (JIDs de wwebjs, IDs de Baileys, etc.) a/desde
 * `Identity` en la frontera; nada fuera de `adapters/*` debería tocar un
 * JID crudo.
 *
 * ## Grupos / formato
 *
 * El server enruta por "formato" de partida (`'2v2' | '4v4'`), no por
 * nombre de chat. `groupIdFor(format)` da el chatId configurado para ese
 * formato; `formatForChat(chatId)` es el inverso (para saber en qué grupo
 * llegó un mensaje entrante).
 *
 * ## Envíos
 *
 * `sendText` / `sendImage` son async y SIEMPRE deben resolver con `{ id }`
 * en éxito o RECHAZAR con un `SendError` (nunca devolver `false`/`null` en
 * fallo — a diferencia de los métodos heredados que sí lo hacen, ver el
 * adaptador de wwebjs). El código nuevo (commandRouter, futuros comandos)
 * debe envolver la llamada en try/catch y decidir según `err.code`:
 *   - 'not_ready'  : el transporte no está listo (sin sesión) — no reintentar ya.
 *   - 'read_only'  : el puerto está en modo solo-lectura (adapters/shadow.js).
 *   - 'transient'  : falla de red/timeout — puede reintentarse.
 *   - 'permanent'  : el mensaje en sí es inválido (texto vacío, chatId
 *                    inexistente, etc.) — reintentar no ayuda.
 *
 * ## Eventos (EventEmitter)
 *
 * - `'status'`  — payload: el mismo shape que `getStatus()`, cada vez que cambia.
 * - `'pairing'` — payload: el mismo shape que `getPairing()`, cuando hay un
 *                 QR/pairing code nuevo (o cuando se limpia, con payload `null`).
 * - `'message'` — payload: `IncomingMessage` (ver abajo), un mensaje entrante
 *                 del grupo (incluye los que manda el propio bot, `fromMe: true`
 *                 — necesario para detectar eco/loops).
 * - `'ack'`     — payload: `{ id: string, status: string }`, confirmación de
 *                 entrega de un mensaje propio enviado antes (best-effort;
 *                 no todos los transportes lo emiten).
 *
 * ```
 * IncomingMessage = {
 *   id: string,
 *   chatId: string,
 *   format: '2v2'|'4v4'|null,   // null si el chat no está mapeado a un formato
 *   fromMe: boolean,
 *   timestamp: number,          // epoch ms
 *   sender: Identity,
 *   text: string,
 *   mentions: Identity[],
 *   raw: unknown,               // el mensaje nativo del transporte, por si acaso
 * }
 * ```
 */

'use strict';

const { EventEmitter } = require('events');

const SEND_ERROR_CODES = new Set(['not_ready', 'read_only', 'transient', 'permanent']);

/** Error tipado para fallos de envío (ver sendText/sendImage arriba). */
class SendError extends Error {
    /**
     * @param {string} message
     * @param {'not_ready'|'read_only'|'transient'|'permanent'} code
     * @param {{cause?: Error}} [opts]
     */
    constructor(message, code, opts = {}) {
        super(message, opts);
        if (!SEND_ERROR_CODES.has(code)) {
            throw new Error(`SendError: código inválido "${code}"`);
        }
        this.name = 'SendError';
        this.code = code;
    }
}

/** Lanzado por defecto por operaciones opcionales que un adaptador no soporta. */
class NotSupportedError extends Error {
    constructor(what) {
        super(`${what}: no soportado por este transporte`);
        this.name = 'NotSupportedError';
    }
}

/**
 * Clase base — documenta el contrato vía JSDoc y da defaults razonables
 * ("no-op" o "throw NotSupported") para que un adaptador solo tenga que
 * sobreescribir lo que de verdad implementa. NO instanciar directamente.
 */
class MessagingPort extends EventEmitter {
    constructor() {
        super();
        if (new.target === MessagingPort) {
            throw new Error('MessagingPort es abstracta; usa un adaptador (adapters/*.js)');
        }
    }

    /** Arranca el transporte (conectar, o quedarse en no-op si está deshabilitado). */
    async start() {
        throw new NotSupportedError('start()');
    }

    /** Detiene el transporte de forma limpia; getStatus().state pasa a 'stopped'. */
    async stop() {
        throw new NotSupportedError('stop()');
    }

    /** @returns {boolean} true solo si se puede enviar AHORA MISMO. */
    isReady() {
        return false;
    }

    /**
     * @returns {{
     *   transport: string,
     *   state: 'disabled'|'starting'|'waiting_pairing'|'connecting'|'ready'|'reconnecting'|'logged_out'|'replaced'|'stopped',
     *   since: string|null,
     *   lastError: string|null,
     *   reconnects: number,
     *   groups: {'2v2': {id:string,name?:string}|null, '4v4': {id:string,name?:string}|null},
     *   self: import('./jid').Identity|null,
     *   readOnly: boolean,
     * }}
     */
    getStatus() {
        return {
            transport: 'unknown',
            state: 'disabled',
            since: null,
            lastError: null,
            reconnects: 0,
            groups: { '2v2': null, '4v4': null },
            self: null,
            readOnly: false,
        };
    }

    /** @returns {{qr?: string, pairingCode?: string, expiresAt?: number}|null} */
    getPairing() {
        return null;
    }

    /**
     * Pide un pairing code (emparejar por número en vez de escanear QR).
     * Por defecto NO soportado (no todos los transportes lo ofrecen).
     * @param {string} _phone
     * @returns {Promise<string>}
     */
    async requestPairingCode(_phone) {
        throw new NotSupportedError('requestPairingCode()');
    }

    /**
     * @param {'2v2'|'4v4'} _format
     * @returns {string|null} chatId configurado/resuelto para ese formato
     */
    groupIdFor(_format) {
        return null;
    }

    /**
     * @param {string} _chatId
     * @returns {'2v2'|'4v4'|null} formato al que pertenece ese chat, o null
     */
    formatForChat(_chatId) {
        return null;
    }

    /** @returns {import('./jid').Identity|null} identidad propia del bot */
    getSelfIdentity() {
        return null;
    }

    /**
     * Token de mención listo para meter en el texto (p.ej. "@5215551234567")
     * y/o en el array `mentions` de sendText, según lo que pida el transporte.
     * @param {import('./jid').Identity} _identity
     * @returns {string}
     */
    mentionJid(_identity) {
        throw new NotSupportedError('mentionJid()');
    }

    /**
     * @param {string} _chatId
     * @param {string} _text
     * @param {{mentions?: string[]}} [_opts]
     * @returns {Promise<{id: string}>}
     * @throws {SendError}
     */
    async sendText(_chatId, _text, _opts = {}) {
        throw new SendError('sendText() no implementado', 'not_ready');
    }

    /**
     * @param {string} _chatId
     * @param {{path: string, caption?: string, mentions?: string[]}} _opts
     * @returns {Promise<{id: string}>}
     * @throws {SendError}
     */
    async sendImage(_chatId, _opts) {
        throw new SendError('sendImage() no implementado', 'not_ready');
    }

    /**
     * Resuelve/enriquece una identidad parcial (p.ej. solo lid) contra el
     * transporte (puente lid↔teléfono). Nunca debe lanzar: en fallo,
     * devuelve la identidad de entrada tal cual.
     * @param {import('./jid').Identity} identity
     * @param {{network?: boolean}} [_opts] - network:false para no golpear la red
     * @returns {Promise<import('./jid').Identity>}
     */
    async resolveIdentity(identity, _opts = {}) {
        return identity;
    }

    /**
     * @param {import('./jid').Identity} _identity
     * @returns {Promise<string|null>} nombre visible (pushname/nombre), o null
     */
    async getDisplayName(_identity) {
        return null;
    }

    /**
     * @param {'2v2'|'4v4'} _format
     * @returns {Promise<Array<{identity: import('./jid').Identity, isAdmin: boolean, displayName?: string}>>}
     */
    async getGroupParticipants(_format) {
        return [];
    }

    /** @returns {Promise<Array<{id: string, name: string, participantsCount: number}>>} */
    async listGroups() {
        return [];
    }
}

module.exports = { MessagingPort, SendError, NotSupportedError };
