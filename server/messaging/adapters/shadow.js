/**
 * ShadowPort (Fase A3, comparación en Fase A5): envuelve otro MessagingPort
 * en modo solo-lectura.
 *
 * Pensado para correr un transporte nuevo (Baileys, Fase A5) en paralelo al
 * real sin riesgo: recibe y loggea todo lo que llega, pero cualquier intento
 * de enviar truena con `SendError('read_only')` en vez de mandar algo de
 * verdad al grupo.
 *
 * Todo lo demás (status, pairing, listGroups, resolveIdentity...) se delega
 * tal cual al puerto envuelto.
 *
 * Comparación (Fase A5): si se pasa `opts.primary` (el MessagingPort
 * primario, p.ej. otra instancia de Baileys corriendo con la sesión real),
 * el shadow recuerda los últimos mensajes que el primario emitió (LRU) y,
 * cuando ve el MISMO id por su lado, loggea una línea `shadow.compare` con
 * `match: boolean` — la validación de que el transporte nuevo interpreta el
 * tráfico real igual que el viejo. Sin `primary` (p.ej. shadow 'fake', o
 * shadow de un transporte distinto al primario) esto simplemente no corre.
 */

'use strict';

const { MessagingPort, SendError } = require('../port');
const { identityKeys, sameIdentity } = require('../jid');

const PRIMARY_LRU_CAP = 200;

class ShadowPort extends MessagingPort {
    /**
     * @param {import('../port').MessagingPort} inner
     * @param {{logger?: {info: function}, primary?: import('../port').MessagingPort|null}} [opts]
     */
    constructor(inner, opts = {}) {
        super();
        if (!inner) throw new Error('ShadowPort requiere un puerto interno');
        this.inner = inner;
        this.logger = opts.logger || { info() {} };
        this.primary = opts.primary || null;
        this._primaryMessages = new Map(); // id -> { sender, text, mentions } (LRU, ver PRIMARY_LRU_CAP)

        if (this.primary) {
            this.primary.on('message', msg => this._rememberPrimary(msg));
        }

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
            this._compareWithPrimary(msg);
            this.emit('message', msg);
        });
    }

    /** Recuerda (LRU) un mensaje que el primario ya emitió, para comparar cuando el shadow vea el mismo id. */
    _rememberPrimary(msg) {
        if (!msg?.id) return;
        this._primaryMessages.set(msg.id, { sender: msg.sender || {}, text: msg.text || '', mentions: msg.mentions || [] });
        if (this._primaryMessages.size > PRIMARY_LRU_CAP) {
            this._primaryMessages.delete(this._primaryMessages.keys().next().value);
        }
    }

    /** Si el primario ya vio este mismo id, loggea `shadow.compare` con el resultado. */
    _compareWithPrimary(msg) {
        if (!this.primary || !msg?.id) return;
        const primaryMsg = this._primaryMessages.get(msg.id);
        if (!primaryMsg) return; // el primario no ha visto (o nunca verá) este id

        const senderMatch = sameIdentity(primaryMsg.sender, msg.sender || {})
            || (identityKeys(primaryMsg.sender).length === 0 && identityKeys(msg.sender || {}).length === 0);
        const textMatch = primaryMsg.text === (msg.text || '');
        const mentionKeysA = JSON.stringify((primaryMsg.mentions || []).map(identityKeys).sort());
        const mentionKeysB = JSON.stringify((msg.mentions || []).map(identityKeys).sort());
        const mentionsMatch = mentionKeysA === mentionKeysB;

        this.logger.info({
            mod: 'shadow',
            id: msg.id,
            match: senderMatch && textMatch && mentionsMatch,
            sender: identityKeys(msg.sender || {}),
            text: msg.text,
            mentions: (msg.mentions || []).map(identityKeys),
        }, 'shadow.compare');
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
