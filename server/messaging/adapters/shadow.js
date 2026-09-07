/**
 * ShadowPort (Fase A3): envuelve otro MessagingPort en modo solo-lectura.
 *
 * Pensado para correr un transporte nuevo (p.ej. el futuro adaptador de
 * Baileys, Fase A5) en paralelo al real sin riesgo: recibe y loggea todo lo
 * que llega, pero cualquier intento de enviar truena con
 * `SendError('read_only')` en vez de mandar algo de verdad al grupo.
 *
 * Todo lo demás (status, pairing, listGroups, resolveIdentity...) se delega
 * tal cual al puerto envuelto.
 */

'use strict';

const { MessagingPort, SendError } = require('../port');
const { identityKeys } = require('../jid');

class ShadowPort extends MessagingPort {
    /**
     * @param {import('../port').MessagingPort} inner
     * @param {{logger?: {info: function}}} [opts]
     */
    constructor(inner, opts = {}) {
        super();
        if (!inner) throw new Error('ShadowPort requiere un puerto interno');
        this.inner = inner;
        this.logger = opts.logger || { info() {} };

        // Reenvía los eventos del puerto interno tal cual, y además loggea
        // cada mensaje entrante ya interpretado (sin exponer texto crudo de
        // más de la cuenta: solo lo que ya es responsabilidad del server ver).
        this.inner.on('status', s => this.emit('status', s));
        this.inner.on('pairing', p => this.emit('pairing', p));
        this.inner.on('ack', a => this.emit('ack', a));
        this.inner.on('message', msg => {
            this.logger.info({
                mod: 'shadow',
                id: msg.id,
                chatId: msg.chatId,
                format: msg.format,
                senderKeys: identityKeys(msg.sender || {}),
                text: msg.text,
                mentionKeys: (msg.mentions || []).map(identityKeys),
            }, 'shadow.message');
            this.emit('message', msg);
        });
    }

    async start() { return this.inner.start(); }
    async stop() { return this.inner.stop(); }
    isReady() { return this.inner.isReady(); }

    getStatus() {
        const status = this.inner.getStatus();
        return { ...status, readOnly: true };
    }

    getPairing() { return this.inner.getPairing(); }
    async requestPairingCode(phone) { return this.inner.requestPairingCode(phone); }
    groupIdFor(format) { return this.inner.groupIdFor(format); }
    formatForChat(chatId) { return this.inner.formatForChat(chatId); }
    getSelfIdentity() { return this.inner.getSelfIdentity(); }
    mentionJid(identity) { return this.inner.mentionJid(identity); }

    async sendText(_chatId, _text, _opts) {
        throw new SendError('ShadowPort es solo-lectura: sendText bloqueado', 'read_only');
    }

    async sendImage(_chatId, _opts) {
        throw new SendError('ShadowPort es solo-lectura: sendImage bloqueado', 'read_only');
    }

    async resolveIdentity(identity, opts) { return this.inner.resolveIdentity(identity, opts); }
    async getDisplayName(identity) { return this.inner.getDisplayName(identity); }
    async getGroupParticipants(format) { return this.inner.getGroupParticipants(format); }
    async listGroups() { return this.inner.listGroups(); }
}

function createShadowPort(inner, opts) {
    return new ShadowPort(inner, opts);
}

module.exports = { ShadowPort, createShadowPort };
