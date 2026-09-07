/**
 * Dobles de prueba para el adaptador de Baileys (Fase A5): un `makeWASocket`
 * falso (EventEmitter `ev` + los métodos que el adaptador llama) inyectable
 * vía `opts.socketFactory`, y helpers para construir mensajes entrantes
 * "estilo Baileys" (`messages.upsert`) sin tocar la red ni disco real.
 *
 * IMPORTANTE: este archivo NO define ningún `test()` — es un helper que
 * importan otros *.test.js. Vive bajo server/test/ (como port.contract.js)
 * a propósito: node --test lo carga pero, al no llamar test() a nivel de
 * módulo, no aporta ningún test propio (ver server/test/messaging/fake.test.js
 * para el mismo patrón con port.contract.js).
 */

'use strict';

const { EventEmitter } = require('events');

let seq = 0;

/** `makeWASocket` falso: sendMessage/groupMetadata/onWhatsApp/requestPairingCode configurables. */
class FakeBaileysSocket {
    constructor(options, behavior = {}) {
        this.options = options; // lo que el adaptador le pasó a makeWASocket(...)
        this.ev = new EventEmitter();
        this.user = behavior.user || {
            id: '5215500000000:1@s.whatsapp.net',
            lid: '900000000001@lid',
            phoneNumber: '5215500000000@s.whatsapp.net',
        };
        this.sent = []; // { jid, content, result }
        this.wsClosed = false;
        this.signalRepository = behavior.signalRepository || null;
        this._sendImpl = behavior.sendImpl || null;
        this._groupMetadataImpl = behavior.groupMetadataImpl || (async (jid) => ({ id: jid, subject: 'Grupo', participants: [] }));
        this._onWhatsAppImpl = behavior.onWhatsAppImpl || (async () => []);
        this._pairingCodeImpl = behavior.pairingCodeImpl || (async (digits) => `CODE-${digits}`);
        this.ws = { close: () => { this.wsClosed = true; } };
        this._nextSendError = null;
    }

    failNextSend(err) {
        this._nextSendError = err;
    }

    async sendMessage(jid, content) {
        if (this._nextSendError) {
            const err = this._nextSendError;
            this._nextSendError = null;
            throw err;
        }
        const result = this._sendImpl
            ? await this._sendImpl(jid, content)
            : { key: { id: `wa-${++seq}`, remoteJid: jid, fromMe: true }, message: content };
        this.sent.push({ jid, content, result });
        return result;
    }

    async groupMetadata(jid) {
        return this._groupMetadataImpl(jid);
    }

    async onWhatsApp(...phoneNumbers) {
        return this._onWhatsAppImpl(...phoneNumbers);
    }

    async requestPairingCode(digits) {
        return this._pairingCodeImpl(digits);
    }
}

/**
 * Fábrica de `socketFactory` inyectable en BaileysPort. Por default, cada
 * socket creado "abre" solo (emite connection.update {connection:'open'}
 * en el próximo tick) — como si el pairing ya estuviera hecho.
 * `factory.sockets` acumula todos los sockets creados (uno por cada
 * start()/reconexión), en orden.
 */
function createFakeSocketFactory({ autoOpen = true, behavior = {}, onCreate } = {}) {
    const sockets = [];
    const factory = (options) => {
        const sock = new FakeBaileysSocket(options, behavior);
        sockets.push(sock);
        if (onCreate) onCreate(sock, options);
        if (autoOpen) {
            setImmediate(() => sock.ev.emit('connection.update', { connection: 'open' }));
        }
        return sock;
    };
    factory.sockets = sockets;
    return factory;
}

/** `authStateFactory` falso: sin disco real, `registered` configurable. */
function makeFakeAuthState({ registered = true } = {}) {
    return async () => ({
        state: { creds: { registered }, keys: {} },
        saveCreds: async () => {},
    });
}

/** `fetchVersion` falso: nunca pega a GitHub. */
async function fakeFetchVersion() {
    return { version: [2, 3000, 0], isLatest: true };
}

/**
 * Construye un mensaje "estilo Baileys" para `messages.upsert`. Con
 * `mentions` (array de JIDs) usa `extendedTextMessage` (como WhatsApp real
 * cuando el texto trae menciones); sin ellas, `conversation` (texto plano).
 */
function makeTextMessage({
    id, chatId, participant, participantAlt, text = '', mentions = [], fromMe = false, pushName, timestampMs,
} = {}) {
    const key = {
        remoteJid: chatId,
        id: id || `MSG${++seq}`,
        fromMe: !!fromMe,
    };
    if (!fromMe && participant) key.participant = participant;
    if (participantAlt) key.participantAlt = participantAlt;

    const message = mentions.length
        ? { extendedTextMessage: { text, contextInfo: { mentionedJid: mentions } } }
        : { conversation: text };

    return {
        key,
        messageTimestamp: Math.floor((timestampMs ?? Date.now()) / 1000),
        pushName,
        message,
    };
}

module.exports = {
    FakeBaileysSocket,
    createFakeSocketFactory,
    makeFakeAuthState,
    fakeFetchVersion,
    makeTextMessage,
};
