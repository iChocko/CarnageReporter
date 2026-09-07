/**
 * Adaptador WhatsApp (Baileys) — Fase A5.
 *
 * Segundo `MessagingPort` real, pensado para correr en modo sombra junto al
 * de whatsapp-web.js (adapters/wwebjs.js) mientras se valida en producción,
 * y eventualmente reemplazarlo (`WHATSAPP_TRANSPORT=baileys`). Es el ÚNICO
 * archivo del repo que importa `@whiskeysockets/baileys` — nada más debe
 * `require()`la directamente.
 *
 * A diferencia de wwebjs.js (que conserva su despacho de comandos heredado
 * tal cual), este adaptador despacha comandos entrantes a través de
 * `messaging/commandRouter.js` de verdad: `registerCommand(trigger, handler)`
 * registra el handler en un `commandRouter` interno y traduce su `ctx`
 * (basado en Identity) a la forma heredada `{format, args, msg, mentionedIds,
 * senderId}` que esperan los comandos reales (server/commands/*.js) —
 * `mentionedIds`/`senderId` salen como JIDs "clásicos" (`toLegacyJid`,
 * ver ../jid.js) para que rosterStore/isAdminSender (que parsean JIDs
 * crudos) seguir funcionando sin cambios.
 *
 * `getStatus()` se queda en el shape LEGADO `{status, transport, groups,
 * configured}` (igual que wwebjs.js) porque health.js y adminWhatsapp.js lo
 * llaman así; el shape completo del contrato MessagingPort vive aparte en
 * `getPortStatus()` (emitido en el evento 'status').
 *
 * Inyección para tests (nunca se conecta a WhatsApp de verdad en tests):
 *   - `opts.socketFactory(options)` reemplaza a `makeWASocket` real.
 *   - `opts.authStateFactory(path)` reemplaza a `useMultiFileAuthState`.
 *   - `opts.fetchVersion()` reemplaza a `fetchLatestBaileysVersion` (que por
 *     defecto pega a GitHub; en tests SIEMPRE se inyecta un fake).
 */

'use strict';

const path = require('path');
const fs = require('fs');
const { logger } = require('../../logger');
const { MessagingPort, SendError, NotSupportedError } = require('../port');
const { createCommandRouter } = require('../commandRouter');
const {
    identityFromJid, identityKeys, mergeIdentity, toLegacyJid,
} = require('../jid');

const log = logger.child({ mod: 'baileys' });

// Versión bundleada de Baileys (Defaults/index.js#DEFAULT_CONNECTION_CONFIG.version),
// usada si fetchLatestBaileysVersion() falla (sin red, GitHub caído, etc.) —
// esa función ya nunca lanza (cae sola a su propio bundle), esto es una capa
// extra de seguridad por si el shape de su resultado cambia entre versiones.
const FALLBACK_BAILEYS_VERSION = [2, 3000, 1043857760];

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 60000;
const RECONNECT_JITTER_MS = 1000;
const ALERT_AFTER_FAILURES = 5;
const REPLACED_RETRY_MS = 5 * 60 * 1000;
const GROUP_META_TTL_MS = 10 * 60 * 1000;
const SENT_CACHE_MAX = 200;
const DEFAULT_SEND_MIN_INTERVAL_MS = 1000; // <=1 msg/s por chat

/** Shape legado de getStatus() (health.js, adminWhatsapp.js) por cada state del contrato. */
function legacyStatusFromState(state) {
    switch (state) {
        case 'waiting_pairing': return 'waiting_qr';
        case 'ready': return 'ready';
        case 'disabled': return 'disabled';
        case 'starting':
        case 'connecting': return 'initializing';
        default: return 'disconnected'; // reconnecting | logged_out | replaced | stopped
    }
}

/** Backoff exponencial 1-60s + jitter, `attempts` = fallos consecutivos (1 en el primero). */
function backoffMs(attempts) {
    const base = Math.min(RECONNECT_BASE_MS * Math.pow(2, attempts - 1), RECONNECT_MAX_MS);
    return base + Math.floor(Math.random() * RECONNECT_JITTER_MS);
}

/** Carga perezosa de baileys real: si WhatsApp/Baileys está apagado no se paga el costo del require. */
function loadBaileys() {
    return require('@whiskeysockets/baileys');
}

class BaileysPort extends MessagingPort {
    /**
     * @param {object} [opts]
     * @param {string} [opts.authSubdir='baileys'] - subcarpeta dentro de
     *   WHATSAPP_AUTH_DIR; la instancia sombra usa 'baileys-shadow' para no
     *   compartir sesión con la primaria (compartir el mismo directorio de
     *   auth entre dos procesos corrompe la sesión).
     * @param {{'2v2'?:{id,name},'4v4'?:{id,name}}} [opts.groupConfig] - por
     *   default se lee de WHATSAPP_GROUP_ID(_4V4)/WHATSAPP_GROUP_NAME(_4V4);
     *   el piloto (WHATSAPP_PILOT=true) inyecta un mapeo aparte con
     *   WHATSAPP_GROUP_ID_TEST -> '2v2'.
     * @param {Function} [opts.socketFactory] - reemplaza a makeWASocket (tests).
     * @param {Function} [opts.authStateFactory] - reemplaza a useMultiFileAuthState (tests).
     * @param {Function} [opts.fetchVersion] - reemplaza a fetchLatestBaileysVersion (tests).
     * @param {number} [opts.minSendIntervalMs] - throttle por chat (default 1000ms; 0 en tests).
     */
    constructor(opts = {}) {
        super();
        this.transport = 'baileys';
        this.enabled = opts.enabled ?? (process.env.WHATSAPP_ENABLED === 'true');

        this.authSubdir = opts.authSubdir || process.env.WHATSAPP_BAILEYS_AUTH_DIR || 'baileys';
        this.authRoot = opts.authDir || process.env.WHATSAPP_AUTH_DIR || path.join(__dirname, '..', '..', '.wwebjs_auth');
        this.authPath = path.join(this.authRoot, this.authSubdir);

        this.groupConfig = opts.groupConfig || {
            '2v2': { id: process.env.WHATSAPP_GROUP_ID || null, name: process.env.WHATSAPP_GROUP_NAME || null },
            '4v4': { id: process.env.WHATSAPP_GROUP_ID_4V4 || null, name: process.env.WHATSAPP_GROUP_NAME_4V4 || null },
        };
        this.resolvedGroups = {};
        this.chatIdToFormat = {};
        for (const format of ['2v2', '4v4']) {
            const cfg = this.groupConfig[format];
            if (cfg?.id) {
                this.resolvedGroups[format] = { id: cfg.id, name: cfg.name || null };
                this.chatIdToFormat[cfg.id] = format;
            }
        }

        this.socketFactory = opts.socketFactory || null;
        this.authStateFactory = opts.authStateFactory || null;
        this.fetchVersion = opts.fetchVersion || null;
        this.minSendIntervalMs = Number.isFinite(opts.minSendIntervalMs) ? opts.minSendIntervalMs : DEFAULT_SEND_MIN_INTERVAL_MS;

        this.sock = null;
        this._creds = null;
        this._saveCreds = null;
        this._credsSavePromise = Promise.resolve();
        this._generation = 0; // se incrementa en cada socket nuevo/stop(); descarta eventos de sockets viejos
        this._reconnectTimer = null;
        this._startResolve = null;

        this._portState = this.enabled ? 'starting' : 'disabled';
        this.since = null;
        this.lastError = null;
        this.reconnects = 0;
        this.consecutiveFailures = 0;
        this.readOnly = false;
        this.self = null;
        this.currentPairing = null; // { qr?, pairingCode?, expiresAt? }

        this.alertHandler = null;
        this.sessionLostAlerted = false;

        // Caché de metadata de grupo (SOLO los grupos configurados; nunca se
        // pide groupMetadata de un grupo ajeno) y de participantes aprendidos
        // (para resolveIdentity/getDisplayName/getGroupParticipants).
        this._groupMetaCache = new Map(); // chatId -> { data, at }
        this._participants = new Map(); // identityKey -> { identity, isAdmin, pushName }

        // LRU de los últimos envíos (id -> proto del mensaje mandado), fuente
        // principal de getMessage() para los reintentos de cifrado de Baileys.
        this._sentCache = new Map();

        // Cola de envío serializada por chat (<=1 msg/s), y el router de
        // comandos interno (ver registerCommand()/handleIncoming más abajo).
        this._sendQueues = new Map(); // chatId -> Promise
        this._lastSendAt = new Map(); // chatId -> epoch ms

        this.router = createCommandRouter(this, {
            maxAgeSec: Number.isFinite(opts.commandMaxAgeSec) ? opts.commandMaxAgeSec : (Number(process.env.COMMAND_MAX_AGE_S) || 120),
            logger: log,
        });

        if (!this.enabled) {
            log.info('📴 WhatsApp (Baileys) deshabilitado (WHATSAPP_ENABLED != true)');
        }
    }

    // ---------------------------------------------------------------- ciclo de vida

    /** Canal de avisos operativos ajeno a WhatsApp (Discord); ver wwebjs.js. */
    setAlertHandler(fn) {
        this.alertHandler = typeof fn === 'function' ? fn : null;
    }

    /** Best effort: nunca lanza ni bloquea el flujo de conexión. */
    notifyAlert(text) {
        if (!this.alertHandler) return;
        Promise.resolve()
            .then(() => this.alertHandler(text))
            .catch(err => log.error({ err }, '⚠️  No se pudo enviar el aviso de WhatsApp (Baileys)'));
    }

    async start() {
        if (!this.enabled) {
            this._setState('disabled');
            return;
        }
        if (this._portState === 'ready') return;
        return new Promise((resolve) => {
            this._startResolve = resolve;
            this._connect().catch(err => {
                log.error({ err }, '❌ Error inicializando WhatsApp (Baileys)');
                this.lastError = String(err?.message || err);
                this._resolveStart();
            });
        });
    }

    async stop() {
        this._generation++; // invalida cualquier evento/timer de sockets/reconexiones en vuelo
        if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
        this._teardownSocket();
        try { await this._credsSavePromise; } catch { /* best effort */ }
        this._setState('stopped');
        this._resolveStart();
    }

    isReady() {
        return this.enabled && this._portState === 'ready';
    }

    _resolveStart() {
        if (this._startResolve) {
            const resolve = this._startResolve;
            this._startResolve = null;
            resolve();
        }
    }

    _setState(state) {
        this._portState = state;
        this.emit('status', this.getPortStatus());
    }

    _teardownSocket() {
        if (!this.sock) return;
        const sock = this.sock;
        this.sock = null;
        try { sock.ev?.removeAllListeners?.(); } catch { /* socket ya roto */ }
        try { sock.ws?.close?.(); } catch { /* socket ya roto */ }
        try { sock.end?.(new Error('BaileysPort: socket reemplazado/detenido')); } catch { /* algunos fakes no lo implementan */ }
    }

    /** Arranca (o reinicia) la conexión: auth state -> versión -> socket nuevo. */
    async _connect() {
        const generation = ++this._generation;
        this._teardownSocket();
        if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }

        if (!fs.existsSync(this.authPath)) fs.mkdirSync(this.authPath, { recursive: true });

        const authStateFactory = this.authStateFactory || (async (dir) => {
            const { useMultiFileAuthState } = loadBaileys();
            return useMultiFileAuthState(dir);
        });
        const { state, saveCreds } = await authStateFactory(this.authPath);
        if (generation !== this._generation) return; // stop()/reconexión más nueva ya en curso
        this._creds = state.creds;
        this._saveCreds = saveCreds;

        this._setState(this._creds?.registered ? 'connecting' : 'waiting_pairing');

        let version = FALLBACK_BAILEYS_VERSION;
        try {
            const fetchVersion = this.fetchVersion || (async () => loadBaileys().fetchLatestBaileysVersion());
            const result = await fetchVersion();
            if (Array.isArray(result?.version)) version = result.version;
        } catch (err) {
            log.warn({ err }, '⚠️  fetchLatestBaileysVersion falló; se usa la versión bundleada');
        }
        if (generation !== this._generation) return;

        const sockLogger = logger.child({ mod: 'baileys-sock' }, { level: 'warn' });
        // Las estáticas (Browsers, makeCacheableSignalKeyStore) SIEMPRE se
        // cargan de la librería real, aunque `socketFactory` esté inyectado
        // (tests): son funciones puras, no golpean red ni WhatsApp, y así el
        // test también ejercita las opciones reales que ve el socket. Solo
        // `makeWASocket` en sí se reemplaza por el factory inyectado.
        const baileysStatics = loadBaileys();
        const makeSocket = this.socketFactory || baileysStatics.default;

        const sock = makeSocket({
            auth: {
                creds: state.creds,
                keys: baileysStatics.makeCacheableSignalKeyStore(state.keys, sockLogger),
            },
            browser: baileysStatics.Browsers.ubuntu('CarnageReporter'),
            markOnlineOnConnect: false,
            syncFullHistory: false,
            shouldSyncHistoryMessage: () => false,
            generateHighQualityLinkPreview: false,
            cachedGroupMetadata: async (jid) => this._groupMetaCache.get(jid)?.data,
            getMessage: async (key) => this._sentCache.get(key.id),
            logger: sockLogger,
            printQRInTerminal: false,
            defaultQueryTimeoutMs: 60000,
            version,
        });

        if (generation !== this._generation) {
            // stop()/una reconexión más nueva ganó la carrera mientras el
            // socket se creaba: no lo dejamos vivo ni le enganchamos listeners.
            try { sock.ev?.removeAllListeners?.(); } catch { /* best effort */ }
            try { sock.ws?.close?.(); } catch { /* best effort */ }
            return;
        }

        this._bindSocket(sock, generation);
    }

    _bindSocket(sock, generation) {
        this.sock = sock;

        sock.ev.on('creds.update', () => {
            if (generation !== this._generation) return;
            this._credsSavePromise = this._credsSavePromise
                .catch(() => {})
                .then(() => this._saveCreds())
                .catch(err => log.warn({ err }, '⚠️  No se pudieron guardar las credenciales de Baileys'));
        });

        sock.ev.on('connection.update', (update) => {
            if (generation !== this._generation) return;
            this._onConnectionUpdate(update, generation).catch(err =>
                log.error({ err }, '❌ Error procesando connection.update (Baileys)'));
        });

        sock.ev.on('messages.upsert', (payload) => {
            if (generation !== this._generation) return;
            this._handleMessagesUpsert(payload);
        });

        sock.ev.on('messages.update', (updates) => {
            if (generation !== this._generation) return;
            for (const u of updates || []) this._handleMessageUpdate(u);
        });

        sock.ev.on('group-participants.update', (ev) => {
            if (generation !== this._generation) return;
            this._invalidateGroupMeta(ev?.id);
        });

        sock.ev.on('groups.update', (updates) => {
            if (generation !== this._generation) return;
            for (const u of updates || []) this._invalidateGroupMeta(u?.id);
        });

        sock.ev.on('lid-mapping.update', (mapping) => {
            if (generation !== this._generation) return;
            this._learnLidMapping(mapping);
        });
    }

    // ---------------------------------------------------------------- pairing / conexión

    async _onConnectionUpdate(update, generation) {
        const { connection, lastDisconnect, qr } = update || {};

        if (qr) {
            this.currentPairing = { qr, expiresAt: Date.now() + 60_000 };
            this._setState('waiting_pairing');
            this.emit('pairing', this.currentPairing);
            this._printQR(qr);
            if (!this.sessionLostAlerted) {
                this.sessionLostAlerted = true;
                this.notifyAlert('🔴 **WhatsApp del bot (Baileys) sin sesión**: pide escanear el QR de nuevo. ' +
                    'Mientras tanto NO se envían reportes, rondas ni comandos al grupo. ' +
                    'QR en GET /api/admin/whatsapp/qr (o `docker logs -f`).');
            }
        }

        if (connection === 'connecting' && this._portState !== 'waiting_pairing') {
            this._setState('connecting');
        }

        if (connection === 'open') {
            await this._onOpen();
        }

        if (connection === 'close') {
            await this._onClose(lastDisconnect, generation);
        }
    }

    /** Imprime el QR en la terminal (ASCII, no envuelto en JSON) — mismo patrón que wwebjs.js. */
    _printQR(qr) {
        const qrcodeTerminal = require('qrcode-terminal');
        /* eslint-disable no-console */
        console.log('\n╔════════════════════════════════════════════╗');
        console.log('║  ESCANEA ESTE CÓDIGO QR (Baileys)          ║');
        console.log('╚════════════════════════════════════════════╝');
        console.log('También disponible en: GET /api/admin/whatsapp/qr?transport=baileys\n');
        qrcodeTerminal.generate(qr, { small: true });
        /* eslint-enable no-console */
    }

    async _onOpen() {
        this.consecutiveFailures = 0;
        this.since = new Date().toISOString();
        this.lastError = null;
        this.currentPairing = null;

        const u = this.sock.user || {};
        try {
            const { jidNormalizedUser } = loadBaileys();
            const pnIdentity = u.id ? identityFromJid(jidNormalizedUser(u.id)) : {};
            const lidIdentity = u.lid ? identityFromJid(u.lid) : {};
            this.self = mergeIdentity(pnIdentity, lidIdentity);
        } catch (err) {
            log.warn({ err }, '⚠️  No se pudo derivar la identidad propia (Baileys)');
        }

        await this._refreshConfiguredGroupsMetadata();

        this._setState('ready');
        this.emit('pairing', null);
        if (this.sessionLostAlerted) {
            this.sessionLostAlerted = false;
            this.notifyAlert('🟢 WhatsApp del bot (Baileys) vinculado de nuevo: los envíos al grupo se reanudan.');
        }
        this._resolveStart();
    }

    async _onClose(lastDisconnect, generation) {
        const err = lastDisconnect?.error;
        const statusCode = err?.output?.statusCode;
        let reason = null;
        try {
            reason = loadBaileys().DisconnectReason[statusCode];
        } catch { /* baileys no cargó (no debería pasar aquí) */ }

        this.lastError = String(err?.message || reason || 'connection closed');
        this._teardownSocket();

        if (reason === 'loggedOut') {
            this._setState('logged_out');
            this.notifyAlert('🔴 **WhatsApp del bot (Baileys) cerró sesión** (logout real). Hace falta volver a emparejar.');
            await this._quarantineAuthDir('loggedout');
            if (generation === this._generation) await this._connect();
            return;
        }

        if (reason === 'restartRequired') {
            if (generation === this._generation) await this._connect();
            return;
        }

        if (reason === 'connectionReplaced') {
            this._setState('replaced');
            this.notifyAlert('🟠 WhatsApp del bot (Baileys): otra sesión tomó su lugar (multi-dispositivo). Reintentando en 5 min.');
            this._scheduleReconnect(REPLACED_RETRY_MS, generation);
            return;
        }

        if (reason === 'badSession') {
            this._setState('waiting_pairing');
            this.notifyAlert('🔴 WhatsApp del bot (Baileys): sesión corrupta (badSession). Se reinicia el emparejamiento.');
            await this._quarantineAuthDir('badsession');
            if (generation === this._generation) await this._connect();
            return;
        }

        if (reason === 'forbidden') {
            this._setState('stopped');
            this.notifyAlert('🔴 WhatsApp del bot (Baileys): conexión rechazada (forbidden). No se reintenta solo; requiere intervención.');
            return;
        }

        // Cualquier otro motivo (timeout, red, etc.): reconectar con backoff.
        this.reconnects++;
        this.consecutiveFailures++;
        this._setState('reconnecting');
        if (this.consecutiveFailures === ALERT_AFTER_FAILURES) {
            this.notifyAlert(`🟠 WhatsApp del bot (Baileys) lleva ${this.consecutiveFailures} reconexiones seguidas fallidas.`);
        }
        this._scheduleReconnect(backoffMs(this.consecutiveFailures), generation);
    }

    _scheduleReconnect(delayMs, generation) {
        if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
        this._reconnectTimer = setTimeout(() => {
            if (generation !== this._generation) return;
            this._connect().catch(err => log.error({ err }, '❌ Error reconectando WhatsApp (Baileys)'));
        }, delayMs);
        this._reconnectTimer.unref?.();
    }

    /** Renombra el directorio de auth (logout/badSession) para empezar limpio; nunca lanza. */
    async _quarantineAuthDir(tag) {
        try {
            if (!fs.existsSync(this.authPath)) return;
            const dest = path.join(this.authRoot, `${this.authSubdir}.${tag}-${Date.now()}`);
            fs.renameSync(this.authPath, dest);
        } catch (err) {
            log.warn({ err }, `⚠️  No se pudo poner en cuarentena el directorio de auth (${tag})`);
        }
    }

    async requestPairingCode(phone) {
        if (!this.sock || this._creds?.registered) {
            throw new NotSupportedError('requestPairingCode()');
        }
        const digits = String(phone || '').replace(/\D/g, '');
        if (!digits) throw new NotSupportedError('requestPairingCode()');
        const code = await this.sock.requestPairingCode(digits);
        this.currentPairing = { ...(this.currentPairing || {}), pairingCode: code, expiresAt: Date.now() + 60_000 };
        this.emit('pairing', this.currentPairing);
        return code;
    }

    getPairing() {
        return this.currentPairing;
    }

    /** Shim heredado (ver adminWhatsapp.js GET /qr). */
    getQR() {
        return this.currentPairing?.qr || null;
    }

    // ---------------------------------------------------------------- grupos / identidad

    groupIdFor(format) {
        return this.resolvedGroups[format]?.id || this.groupConfig[format]?.id || null;
    }

    formatForChat(chatId) {
        return this.chatIdToFormat[chatId] || null;
    }

    getSelfIdentity() {
        return this.self;
    }

    /** JIDs propios (ambas formas), para detectar auto-menciones (ver commands/vincula.js). */
    getOwnIds() {
        const ids = new Set();
        if (this.self?.pn) ids.add(`${this.self.pn}@c.us`);
        if (this.self?.lid) ids.add(`${this.self.lid}@lid`);
        return ids;
    }

    /** `lid@lid` si se conoce, si no `pn@s.whatsapp.net`; '' si la identidad no se reconoce. */
    mentionJid(identity) {
        if (identity?.lid) return `${identity.lid}@lid`;
        if (identity?.pn) return `${identity.pn}@s.whatsapp.net`;
        return '';
    }

    async _refreshConfiguredGroupsMetadata() {
        if (!this.sock) return;
        for (const format of ['2v2', '4v4']) {
            const cfg = this.groupConfig[format];
            if (!cfg?.id) continue;
            try {
                const meta = await this.sock.groupMetadata(cfg.id);
                this._setGroupMeta(cfg.id, meta);
                this.resolvedGroups[format] = { id: cfg.id, name: meta?.subject || cfg.name || null };
                this.chatIdToFormat[cfg.id] = format;
                this._learnParticipants(meta);
            } catch (err) {
                log.warn({ err, format }, `⚠️  No se pudo verificar el grupo ${format} (Baileys)`);
            }
        }
    }

    _setGroupMeta(chatId, data) {
        this._groupMetaCache.set(chatId, { data, at: Date.now() });
    }

    /** SOLO invalida/refresca grupos configurados: nunca pide metadata de un grupo ajeno. */
    _invalidateGroupMeta(chatId) {
        if (!chatId || !this.chatIdToFormat[chatId] || !this.sock) return;
        this.sock.groupMetadata(chatId).then(meta => {
            this._setGroupMeta(chatId, meta);
            this._learnParticipants(meta);
        }).catch(err => log.warn({ err, chatId }, '⚠️  No se pudo refrescar metadata de grupo (Baileys)'));
    }

    _learnParticipants(meta) {
        for (const p of meta?.participants || []) {
            const identity = mergeIdentity(
                identityFromJid(p.phoneNumber || (typeof p.id === 'string' && !p.id.endsWith('@lid') ? p.id : undefined)),
                identityFromJid(p.lid || (typeof p.id === 'string' && p.id.endsWith('@lid') ? p.id : undefined)),
            );
            if (!identity.pn && !identity.lid) continue;
            const isAdmin = p.admin != null;
            for (const key of identityKeys(identity)) {
                const prev = this._participants.get(key);
                this._participants.set(key, { identity, isAdmin, pushName: prev?.pushName });
            }
        }
    }

    _learnLidMapping(mapping) {
        if (!mapping?.pn || !mapping?.lid) return;
        const identity = mergeIdentity(identityFromJid(mapping.pn), identityFromJid(mapping.lid));
        for (const key of identityKeys(identity)) {
            const prev = this._participants.get(key);
            this._participants.set(key, { identity, isAdmin: prev?.isAdmin || false, pushName: prev?.pushName });
        }
    }

    _rememberPushName(identity, pushName) {
        if (!pushName) return;
        for (const key of identityKeys(identity)) {
            const prev = this._participants.get(key);
            this._participants.set(key, { identity: prev?.identity || identity, isAdmin: prev?.isAdmin || false, pushName });
        }
    }

    /**
     * Resuelve/enriquece una Identity: 1) caché de participantes (aprendida de
     * groupMetadata y lid-mapping.update), 2) el puente lid<->pn de la propia
     * sesión de Baileys (signalRepository.lidMapping, si el build lo trae), y
     * 3) SOLO con `network:true`, sock.onWhatsApp(pn) (golpea la red). Nunca
     * lanza: en fallo devuelve la identidad de entrada.
     */
    async resolveIdentity(identity, { network = true } = {}) {
        if (!identity) return {};
        for (const key of identityKeys(identity)) {
            const found = this._participants.get(key);
            if (found) return mergeIdentity(identity, found.identity);
        }

        try {
            const repo = this.sock?.signalRepository?.lidMapping;
            if (repo) {
                if (identity.pn && !identity.lid && typeof repo.getLIDForPN === 'function') {
                    const lid = await repo.getLIDForPN(`${identity.pn}@s.whatsapp.net`);
                    if (lid) return mergeIdentity(identity, identityFromJid(lid));
                }
                if (identity.lid && !identity.pn && typeof repo.getPNForLID === 'function') {
                    const pn = await repo.getPNForLID(`${identity.lid}@lid`);
                    if (pn) return mergeIdentity(identity, identityFromJid(pn));
                }
            }
        } catch (err) {
            log.warn({ err }, '⚠️  resolveIdentity: puente lid<->pn de Baileys falló');
        }

        if (network && identity.pn && this.sock && typeof this.sock.onWhatsApp === 'function') {
            try {
                const results = await this.sock.onWhatsApp(identity.pn);
                const hit = (results || [])[0];
                if (hit?.exists && hit.jid) return mergeIdentity(identity, identityFromJid(hit.jid));
            } catch (err) {
                log.warn({ err }, '⚠️  resolveIdentity: onWhatsApp falló');
            }
        }

        return identity;
    }

    async getDisplayName(identity) {
        if (!identity) return null;
        for (const key of identityKeys(identity)) {
            const found = this._participants.get(key);
            if (found?.pushName) return found.pushName;
        }
        return null;
    }

    /**
     * Shim heredado (ver commands/mentions.js resolveMentionsToTags): jids
     * "clásicos" de entrada, `{pushname, name, number}` de salida.
     */
    async getContactInfo(jid) {
        const identity = identityFromJid(jid);
        const name = await this.getDisplayName(identity);
        return { pushname: name, name, number: identity.pn || null };
    }

    /**
     * Shim heredado (puente lid<->teléfono, ver commands/mentions.js):
     * jids "clásicos" de entrada; salida `{lid?, pn?}` también como jids
     * clásicos (con sufijo), igual que wwebjs.js#resolveLidPn. Sin red por
     * default (los comandos lo llaman seguido); usa resolveIdentity con
     * `network:false`.
     */
    async resolveLidPn(jids) {
        const out = [];
        for (const jid of jids || []) {
            const identity = identityFromJid(jid);
            const resolved = await this.resolveIdentity(identity, { network: false });
            out.push({
                lid: resolved.lid ? `${resolved.lid}@lid` : undefined,
                pn: resolved.pn ? `${resolved.pn}@s.whatsapp.net` : undefined,
            });
        }
        return out;
    }

    async getGroupParticipants(format) {
        const chatId = this.groupIdFor(format);
        if (!chatId) return [];

        const cached = this._groupMetaCache.get(chatId);
        const stale = !cached || (Date.now() - cached.at > GROUP_META_TTL_MS);
        if (stale && this.sock) {
            try {
                const meta = await this.sock.groupMetadata(chatId);
                this._setGroupMeta(chatId, meta);
                this._learnParticipants(meta);
            } catch (err) {
                if (!cached) { log.warn({ err, format }, '⚠️  getGroupParticipants: sin caché ni red disponible'); return []; }
            }
        }

        const meta = this._groupMetaCache.get(chatId)?.data;
        if (!meta) return [];
        return (meta.participants || []).map(p => {
            const identity = mergeIdentity(
                identityFromJid(p.phoneNumber || (typeof p.id === 'string' && !p.id.endsWith('@lid') ? p.id : undefined)),
                identityFromJid(p.lid || (typeof p.id === 'string' && p.id.endsWith('@lid') ? p.id : undefined)),
            );
            const key = identityKeys(identity)[0];
            return {
                identity,
                isAdmin: p.admin != null,
                displayName: (key && this._participants.get(key)?.pushName) || undefined,
            };
        });
    }

    /**
     * Solo los grupos configurados/resueltos (nunca se recorre TODA la lista
     * de grupos del bot: ver la nota de "network calls" en la cabecera).
     */
    async listGroups() {
        return Object.entries(this.resolvedGroups)
            .filter(([, g]) => g?.id)
            .map(([format, g]) => ({
                id: g.id,
                name: g.name || format,
                participantsCount: this._groupMetaCache.get(g.id)?.data?.participants?.length || 0,
            }));
    }

    // ---------------------------------------------------------------- comandos

    /**
     * Registra un comando (server/commands/index.js llama esto igual que con
     * wwebjs.js). Por dentro delega SIEMPRE en el commandRouter genérico
     * (server/messaging/commandRouter.js): el handler real recibe la forma
     * heredada `{format, args, msg, mentionedIds, senderId}` que ya esperan
     * los comandos (server/commands/*.js), traducida desde el ctx basado en
     * Identity del router (mentions/sender -> JIDs clásicos vía toLegacyJid).
     */
    registerCommand(trigger, handler) {
        this.router.registerCommand(trigger, async (ctx) => handler({
            format: ctx.format,
            args: ctx.args,
            msg: ctx.msg,
            mentionedIds: (ctx.mentions || []).map(toLegacyJid).filter(Boolean),
            senderId: toLegacyJid(ctx.sender) || null,
        }));
    }

    // ---------------------------------------------------------------- entrantes

    _handleMessagesUpsert({ messages, type } = {}) {
        if (type !== 'notify') return; // ignora 'append' y sync de historial
        for (const m of messages || []) {
            try {
                this._handleOneMessage(m);
            } catch (err) {
                log.warn({ err }, '⚠️  No se pudo traducir un mensaje entrante de Baileys');
            }
        }
    }

    _handleOneMessage(m) {
        const key = m?.key || {};
        const chatId = key.remoteJid;
        if (!chatId) return;
        const format = this.chatIdToFormat[chatId] || null;
        if (!format) return; // solo se procesan los grupos configurados

        const { normalizeMessageContent, getContentType } = loadBaileys();
        const content = normalizeMessageContent(m.message);
        if (!content) return; // mensajes de protocolo/reacciones/etc. sin texto
        const contentType = getContentType(content);

        const text = content.conversation ?? content.extendedTextMessage?.text ?? '';
        const contextInfo = content.extendedTextMessage?.contextInfo
            || (contentType ? content[contentType]?.contextInfo : null)
            || null;
        const mentions = (contextInfo?.mentionedJid || []).map(identityFromJid);

        let sender = identityFromJid(key.fromMe ? null : (key.participant || chatId));
        if (key.participantAlt) sender = mergeIdentity(sender, identityFromJid(key.participantAlt));
        if (key.fromMe && this.self) sender = mergeIdentity(sender, this.self);
        if (m.pushName) this._rememberPushName(sender, m.pushName);

        const id = key.id || `${chatId}-${m.messageTimestamp || Date.now()}`;
        const timestamp = m.messageTimestamp ? Number(m.messageTimestamp) * 1000 : Date.now();

        const incoming = {
            id, chatId, format, fromMe: !!key.fromMe, timestamp, sender, text, mentions, raw: m,
        };
        this.emit('message', incoming);
    }

    _handleMessageUpdate({ key, update } = {}) {
        if (!key?.id) return;
        const status = update?.status;
        if (typeof status === 'number' && status >= 2) {
            this.emit('ack', { id: key.id, status });
        }
    }

    // ---------------------------------------------------------------- envíos

    _rememberSent(result) {
        const id = result?.key?.id;
        if (!id) return;
        this._sentCache.set(id, result.message);
        if (this._sentCache.size > SENT_CACHE_MAX) {
            this._sentCache.delete(this._sentCache.keys().next().value);
        }
    }

    /** Clasifica un error de sock.sendMessage a un código de SendError. */
    _mapSendError(err) {
        if (!this.isReady()) return new SendError('WhatsApp (Baileys) no está listo', 'not_ready', { cause: err });
        const statusCode = err?.output?.statusCode;
        const msg = String(err?.message || '');
        if (statusCode === 403 || statusCode === 401 || /forbidden|not-authorized|invalid jid|item-not-found/i.test(msg)) {
            return new SendError('Envío rechazado por WhatsApp (Baileys)', 'permanent', { cause: err });
        }
        return new SendError('Fallo transitorio enviando por WhatsApp (Baileys)', 'transient', { cause: err });
    }

    /** Serializa los envíos de un chat (<=1 msg/s) sin bloquear otros chats. */
    _enqueueSend(chatId, fn) {
        const prevChain = this._sendQueues.get(chatId) || Promise.resolve();
        const earliestAt = (this._lastSendAt.get(chatId) || 0) + this.minSendIntervalMs;
        const next = prevChain.catch(() => {}).then(async () => {
            const waitMs = earliestAt - Date.now();
            if (waitMs > 0) await new Promise(r => setTimeout(r, waitMs));
            this._lastSendAt.set(chatId, Date.now());
            return fn();
        });
        // Evita que un rechazo deje la cadena "envenenada" para el siguiente envío.
        this._sendQueues.set(chatId, next.catch(() => {}));
        return next;
    }

    async sendText(chatId, text, opts = {}) {
        if (!chatId || !text) throw new SendError('sendText requiere chatId y text', 'permanent');
        if (this.readOnly) throw new SendError('WhatsApp (Baileys) en modo solo-lectura', 'read_only');
        if (!this.isReady()) throw new SendError('WhatsApp (Baileys) no está listo', 'not_ready');
        return this._enqueueSend(chatId, async () => {
            try {
                const result = await this.sock.sendMessage(chatId, { text, mentions: opts.mentions || undefined });
                this._rememberSent(result);
                return { id: result.key.id };
            } catch (err) {
                throw this._mapSendError(err);
            }
        });
    }

    async _doSendImage(chatId, { path: imagePath, caption, mentions } = {}) {
        return this._enqueueSend(chatId, async () => {
            try {
                const result = await this.sock.sendMessage(chatId, {
                    image: { url: imagePath },
                    caption: caption || '',
                    mentions: mentions || undefined,
                });
                this._rememberSent(result);
                return { id: result.key.id };
            } catch (err) {
                throw this._mapSendError(err);
            }
        });
    }

    async _sendImagePort(chatId, { path: imagePath, caption, mentions } = {}) {
        if (!chatId || !imagePath) throw new SendError('sendImage requiere chatId y path', 'permanent');
        if (this.readOnly) throw new SendError('WhatsApp (Baileys) en modo solo-lectura', 'read_only');
        if (!this.isReady()) throw new SendError('WhatsApp (Baileys) no está listo', 'not_ready');
        return this._doSendImage(chatId, { path: imagePath, caption, mentions });
    }

    async _sendImageLegacy(imagePath, caption, chatId) {
        if (!this.enabled || !this.isReady() || !chatId) return false;
        try {
            await this._doSendImage(chatId, { path: imagePath, caption });
            return true;
        } catch (err) {
            log.error({ err }, '❌ Error enviando imagen (Baileys)');
            return false;
        }
    }

    /**
     * Dos formas conviven bajo el mismo nombre (igual que wwebjs.js): la
     * heredada `sendImage(imagePath, caption, chatId)` -> boolean, y la de
     * MessagingPort `sendImage(chatId, {path, caption, mentions})` -> {id}.
     */
    async sendImage(a, b, c) {
        if (b !== null && typeof b === 'object') return this._sendImagePort(a, b || {});
        return this._sendImageLegacy(a, b, c);
    }

    /** Forma heredada de un envío de texto: nunca lanza, boolean. */
    async sendMessage(text, chatId, options) {
        if (!this.enabled || !this.isReady() || !chatId) return false;
        try {
            await this.sendText(chatId, text, options?.mentions ? { mentions: options.mentions } : {});
            return true;
        } catch (err) {
            log.error({ err }, '❌ Error enviando mensaje (Baileys)');
            return false;
        }
    }

    // ---------------------------------------------------------------- status

    /**
     * Shape LEGADO (health.js, adminWhatsapp.js): `{status, transport, groups,
     * configured}`. El shape completo del contrato MessagingPort vive en
     * getPortStatus() (ver JSDoc de la clase).
     */
    getStatus() {
        return {
            status: legacyStatusFromState(this._portState),
            transport: this.transport,
            groups: {
                '2v2': this.resolvedGroups['2v2'] || null,
                '4v4': this.resolvedGroups['4v4'] || null,
            },
            configured: {
                '2v2': this.groupConfig['2v2'],
                '4v4': this.groupConfig['4v4'],
            },
        };
    }

    /** Shape completo del contrato MessagingPort (ver port.js JSDoc). */
    getPortStatus() {
        return {
            transport: this.transport,
            state: this._portState,
            since: this.since,
            lastError: this.lastError,
            reconnects: this.reconnects,
            groups: {
                '2v2': this.resolvedGroups['2v2'] || this.groupConfig['2v2'] || null,
                '4v4': this.resolvedGroups['4v4'] || this.groupConfig['4v4'] || null,
            },
            self: this.self,
            readOnly: this.readOnly,
        };
    }
}

module.exports = BaileysPort;
module.exports.BaileysPort = BaileysPort;
module.exports.legacyStatusFromState = legacyStatusFromState;
