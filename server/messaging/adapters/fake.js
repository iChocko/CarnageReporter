/**
 * FakePort (Fase A3): implementación en memoria de MessagingPort para
 * tests — de commandRouter, del contrato (server/test/messaging/port.contract.js)
 * y de comandos que se quieran probar end-to-end sin whatsapp-web.js.
 *
 * No hace red ni disco: `sendText`/`sendImage` solo registran lo enviado en
 * `sent`, y `emitIncoming(...)` deja que un test simule un mensaje entrante.
 */

'use strict';

const { MessagingPort, SendError } = require('../port');
const { sameIdentity } = require('../jid');

let nextId = 1;

class FakePort extends MessagingPort {
    /**
     * @param {object} [opts]
     * @param {import('../jid').Identity} [opts.self] - identidad del "bot"
     * @param {{'2v2'?: {id:string,name?:string}, '4v4'?: {id:string,name?:string}}} [opts.groups]
     */
    constructor(opts = {}) {
        super();
        this.transport = 'fake';
        this.state = 'stopped';
        this.since = null;
        this.lastError = null;
        this.reconnects = 0;
        this.self = opts.self || { pn: '10000000000' };
        this.groups = { '2v2': opts.groups?.['2v2'] || null, '4v4': opts.groups?.['4v4'] || null };
        this.chatIdToFormat = {};
        for (const [format, group] of Object.entries(this.groups)) {
            if (group?.id) this.chatIdToFormat[group.id] = format;
        }
        this.pairing = null;
        this.sent = []; // { kind: 'text'|'image', chatId, text?, path?, caption?, mentions?, id }
        this.readOnly = false;
        this.knownDisplayNames = new Map(); // identityKey -> nombre
        this.groupParticipants = { '2v2': [], '4v4': [] };
    }

    async start() {
        this.state = 'ready';
        this.since = new Date().toISOString();
        this._emitStatus();
    }

    async stop() {
        this.state = 'stopped';
        this._emitStatus();
    }

    isReady() {
        return this.state === 'ready';
    }

    getStatus() {
        return {
            transport: this.transport,
            state: this.state,
            since: this.since,
            lastError: this.lastError,
            reconnects: this.reconnects,
            groups: this.groups,
            self: this.self,
            readOnly: this.readOnly,
        };
    }

    getPairing() {
        return this.pairing;
    }

    async requestPairingCode(phone) {
        this.pairing = { pairingCode: `FAKE-${phone}`.slice(0, 12), expiresAt: Date.now() + 60_000 };
        this._emitPairing();
        return this.pairing.pairingCode;
    }

    groupIdFor(format) {
        return this.groups[format]?.id || null;
    }

    formatForChat(chatId) {
        return this.chatIdToFormat[chatId] || null;
    }

    getSelfIdentity() {
        return this.self;
    }

    mentionJid(identity) {
        return identity?.pn || identity?.lid || '';
    }

    async sendText(chatId, text, opts = {}) {
        if (this.readOnly) throw new SendError('FakePort en modo solo-lectura', 'read_only');
        if (!this.isReady()) throw new SendError('FakePort no está listo', 'not_ready');
        if (!chatId || !text) throw new SendError('sendText requiere chatId y text', 'permanent');
        const id = `fake-${nextId++}`;
        this.sent.push({ kind: 'text', chatId, text, mentions: opts.mentions || [], id });
        return { id };
    }

    async sendImage(chatId, opts = {}) {
        if (this.readOnly) throw new SendError('FakePort en modo solo-lectura', 'read_only');
        if (!this.isReady()) throw new SendError('FakePort no está listo', 'not_ready');
        if (!chatId || !opts.path) throw new SendError('sendImage requiere chatId y path', 'permanent');
        const id = `fake-${nextId++}`;
        this.sent.push({ kind: 'image', chatId, path: opts.path, caption: opts.caption || '', mentions: opts.mentions || [], id });
        return { id };
    }

    async resolveIdentity(identity) {
        return identity;
    }

    async getDisplayName(identity) {
        for (const [key, name] of this.knownDisplayNames) {
            if (sameIdentity({ [key.split(':')[0]]: key.split(':')[1] }, identity)) return name;
        }
        return null;
    }

    async getGroupParticipants(format) {
        return this.groupParticipants[format] || [];
    }

    async listGroups() {
        return Object.entries(this.groups)
            .filter(([, g]) => g)
            .map(([format, g]) => ({ id: g.id, name: g.name || format, participantsCount: 0 }));
    }

    // --- helpers de test (no forman parte del contrato) ---

    /** Simula un mensaje entrante; ver IncomingMessage en port.js. */
    emitIncoming({ id, chatId, fromMe = false, timestamp = Date.now(), sender = {}, text = '', mentions = [], raw = null } = {}) {
        const format = this.formatForChat(chatId);
        const msg = {
            id: id || `in-${nextId++}`,
            chatId,
            format,
            fromMe,
            timestamp,
            sender,
            text,
            mentions,
            raw,
        };
        this.emit('message', msg);
        return msg;
    }

    setReadOnly(value) {
        this.readOnly = value;
    }

    setDisplayName(identityKey, name) {
        this.knownDisplayNames.set(identityKey, name);
    }

    setGroupParticipants(format, participants) {
        this.groupParticipants[format] = participants;
    }

    _emitStatus() {
        this.emit('status', this.getStatus());
    }

    _emitPairing() {
        this.emit('pairing', this.pairing);
    }
}

function createFakePort(opts) {
    return new FakePort(opts);
}

module.exports = { FakePort, createFakePort };
