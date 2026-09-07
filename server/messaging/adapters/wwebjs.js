/**
 * Adaptador WhatsApp (whatsapp-web.js) — Fase A3.
 *
 * Es el `MessagingPort` real de producción: mismo comportamiento que el
 * viejo `server/services/whatsapp.js` (Fase A0-A2), movido aquí y con la
 * superficie de MessagingPort encima. El despacho de comandos EN VIVO
 * (`handleIncomingMessage`, el Map `this.commands`) se deja tal cual estaba
 * — es la ruta que corre en producción hoy y no tiene red de tests propia
 * (whatsapp-web.js necesita Chromium real), así que no vale la pena
 * arriesgar un comportamiento distinto solo por pureza del contrato.
 *
 * Lo nuevo son shims ADICIONALES que traducen ese estado interno al
 * contrato de MessagingPort (getSelfIdentity, mentionJid, sendText,
 * formatForChat, getPairing...) para que comandos/infra nuevos puedan
 * programar contra el contrato — y para que un futuro adaptador (Baileys,
 * Fase A5) tenga que respetar el mismo shape. Los métodos heredados
 * (`sendImage(imagePath, caption, chatId)`, `sendMessage(text, chatId, opts)`,
 * `isReady()`, `groupIdFor()`, `getQR()`, `registerCommand()`, `authPath`,
 * `setAlertHandler()`, `notifyAlert()`) NO cambian de firma ni de
 * comportamiento: `report/pipeline.js`, `domain/saldos.js`, `jobs/*` y
 * `health.js` los siguen llamando exactamente igual.
 *
 * - Se habilita con WHATSAPP_ENABLED=true; si está apagado, todo es no-op.
 * - Sesión persistente con LocalAuth en WHATSAPP_AUTH_DIR (default server/.wwebjs_auth).
 *   En Docker debe montarse como volumen para sobrevivir redeploys.
 * - Pairing: el QR se imprime en logs y queda disponible para el endpoint
 *   admin GET /api/admin/whatsapp/qr (via getQR()).
 * - Grupo destino: WHATSAPP_GROUP_ID (preciso) o WHATSAPP_GROUP_NAME.
 */

const path = require('path');
const fs = require('fs');
const { logger } = require('../../logger');
const { MessagingPort, SendError, NotSupportedError } = require('../port');
const { identityFromJid, mergeIdentity, toLegacyJid } = require('../jid');

const log = logger.child({ mod: 'whatsapp' });

class WwebjsPort extends MessagingPort {
    constructor() {
        super();
        this.transport = 'wwebjs';
        this.enabled = process.env.WHATSAPP_ENABLED === 'true';
        this.client = null;
        this.ready = false;
        this.currentQR = null;
        this.status = this.enabled ? 'initializing' : 'disabled';
        // Grupos destino por formato. 2v2 -> Retas H3, 4v4 -> Torneos Halo 3.
        this.groupConfig = {
            '2v2': { id: process.env.WHATSAPP_GROUP_ID || null, name: process.env.WHATSAPP_GROUP_NAME || null },
            '4v4': { id: process.env.WHATSAPP_GROUP_ID_4V4 || null, name: process.env.WHATSAPP_GROUP_NAME_4V4 || null },
        };
        // format -> chatId resuelto (tras conectar); y el inverso chatId -> format
        this.resolvedGroups = {};
        this.chatIdToFormat = {};
        this.authPath = process.env.WHATSAPP_AUTH_DIR || path.join(__dirname, '..', '..', '.wwebjs_auth');
        this.isRestarting = false;
        this.keepAliveInterval = null;
        this.keepAliveIntervalMs = 5 * 60 * 1000; // 5 minutos
        this.initTimeoutMs = 180000; // 180s (VPS lentos)
        this.maxRetries = 5;
        this.baseRetryDelayMs = 1000;
        this.initRetryCount = 0; // fallos consecutivos de initialize(); se resetea al llegar a 'ready'
        this.commands = new Map(); // trigger (lowercase) -> async handler que devuelve el texto de respuesta
        this.ownIds = new Set();   // JIDs propios del bot (wid + su LID), para detectar auto-menciones
        // Aviso fuera de WhatsApp (Discord) cuando la sesión se cae y pide QR:
        // sin esto la caída es silenciosa (los reportes solo omiten WhatsApp).
        this.alertHandler = null;
        this.sessionLostAlerted = false; // un aviso por episodio, no por cada QR (se regenera cada ~30s)
        this.since = null;
        this.lastError = null;
        this.reconnects = 0;
        this.readOnly = false;

        if (!this.enabled) {
            log.info('📴 WhatsApp deshabilitado (WHATSAPP_ENABLED != true)');
        }
    }

    /**
     * Detecta la ruta de Chromium en el sistema.
     * En Docker el Dockerfile define PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium.
     */
    getChromiumPath() {
        if (process.env.PUPPETEER_EXECUTABLE_PATH) {
            return process.env.PUPPETEER_EXECUTABLE_PATH;
        }

        const possiblePaths = [
            '/usr/bin/chromium',
            '/usr/bin/chromium-browser',
            '/usr/bin/google-chrome-stable',
            '/usr/bin/google-chrome',
            '/snap/bin/chromium',
        ];

        for (const p of possiblePaths) {
            if (fs.existsSync(p)) {
                log.info(`🌐 WhatsApp usando Chromium: ${p}`);
                return p;
            }
        }
        return null;
    }

    /**
     * Limpia archivos de bloqueo de Chromium huérfanos (crash previo)
     */
    cleanupLockFiles() {
        if (!fs.existsSync(this.authPath)) return;

        const lockPatterns = ['SingletonLock', 'SingletonCookie', 'SingletonSocket', '.org.chromium.Chromium.lock'];

        const cleanDirectory = (dir) => {
            try {
                for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
                    const fullPath = path.join(dir, item.name);
                    if (item.isDirectory()) {
                        cleanDirectory(fullPath);
                    } else if (lockPatterns.some(pattern => item.name.includes(pattern))) {
                        try { fs.unlinkSync(fullPath); } catch { /* archivo de lock ya liberado o inexistente */ }
                    }
                }
            } catch { /* directorio no accesible: se ignora, no es crítico */ }
        };

        cleanDirectory(this.authPath);
    }

    /**
     * Canal de avisos operativos ajeno a WhatsApp (ej. webhook de Discord).
     * @param {(text: string) => Promise<boolean>|boolean} fn
     */
    setAlertHandler(fn) {
        this.alertHandler = typeof fn === 'function' ? fn : null;
    }

    /** Best effort: nunca lanza ni bloquea el flujo de conexión. */
    notifyAlert(text) {
        if (!this.alertHandler) return;
        Promise.resolve()
            .then(() => this.alertHandler(text))
            .catch(err => log.error({ err }, '⚠️  No se pudo enviar el aviso de WhatsApp'));
    }

    getRetryDelay(attempt) {
        // Backoff exponencial: 1s, 2s, 4s, 8s, 16s (cap 30s)
        return Math.min(this.baseRetryDelayMs * Math.pow(2, attempt - 1), 30000);
    }

    /**
     * Reintento de conexión con backoff (cap 30s), indefinido hasta que
     * 'ready' resetee initRetryCount. Libera isRestarting primero: si no,
     * un fallo de initialize() deja la bandera pegada en true para siempre
     * y bloquea cualquier restart() futuro (keep-alive, 'disconnected', etc).
     */
    scheduleReconnect() {
        if (!this.enabled) return;
        this.isRestarting = false;
        this.initRetryCount++;
        this.reconnects++;
        const delay = this.getRetryDelay(this.initRetryCount);
        log.info(`🔁 Reintentando conexión de WhatsApp en ${delay / 1000}s (intento ${this.initRetryCount})...`);
        setTimeout(() => this.restart(), delay);
    }

    async ensureConnection() {
        if (!this.ready || !this.client) return false;

        try {
            const state = await this.client.getState();
            if (state !== 'CONNECTED') {
                log.warn(`⚠️  Estado de WhatsApp: ${state} (esperado: CONNECTED)`);
                return false;
            }
            return true;
        } catch (error) {
            log.warn({ err: error }, '⚠️  Verificación de conexión WhatsApp falló');
            return false;
        }
    }

    async initialize() {
        if (!this.enabled) return;

        // Cargar deps aquí: si WhatsApp está apagado no se paga el costo de require
        const { Client, LocalAuth } = require('whatsapp-web.js');
        const qrcodeTerminal = require('qrcode-terminal');

        if (this.client) {
            log.warn('⚠️  WhatsApp ya inicializado, destruyendo sesión anterior...');
            await this.destroy();
        }

        return new Promise((resolve) => {
            if (!fs.existsSync(this.authPath)) {
                fs.mkdirSync(this.authPath, { recursive: true });
            }
            this.cleanupLockFiles();

            const puppeteerConfig = {
                headless: true,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-accelerated-2d-canvas',
                    '--no-first-run',
                    '--disable-gpu',
                    '--disable-software-rasterizer',
                    '--disable-extensions',
                ]
            };

            const executablePath = this.getChromiumPath();
            if (executablePath) {
                puppeteerConfig.executablePath = executablePath;
            }

            this.client = new Client({
                authStrategy: new LocalAuth({ dataPath: this.authPath }),
                puppeteer: puppeteerConfig
            });

            this.client.on('qr', (qr) => {
                this.currentQR = qr;
                this.status = 'waiting_qr';
                this._setState('waiting_pairing');
                this._emitPairing();
                // El QR debe llegar a `docker logs` como texto plano (dibujo ASCII
                // escaneable), no envuelto en JSON como el resto de los logs.
                /* eslint-disable no-console */
                console.log('\n╔════════════════════════════════════════════╗');
                console.log('║     ESCANEA ESTE CÓDIGO QR CON WHATSAPP    ║');
                console.log('║     (Solo necesitas hacerlo UNA VEZ)       ║');
                console.log('╚════════════════════════════════════════════╝');
                console.log('También disponible en: GET /api/admin/whatsapp/qr\n');
                qrcodeTerminal.generate(qr, { small: true });
                /* eslint-enable no-console */
                if (!this.sessionLostAlerted) {
                    this.sessionLostAlerted = true;
                    this.notifyAlert('🔴 **WhatsApp del bot sin sesión**: pide escanear el QR de nuevo. ' +
                        'Mientras tanto NO se envían reportes, rondas ni comandos al grupo. ' +
                        'QR en GET /api/admin/whatsapp/qr (o `docker logs -f carnage-dashboard`).');
                }
            });

            this.client.on('authenticated', () => {
                log.info('✅ WhatsApp autenticado');
                this.currentQR = null;
                this._setState('connecting');
            });

            this.client.on('ready', async () => {
                this.ready = true;
                this.status = 'ready';
                this.currentQR = null;
                this.isRestarting = false;
                this.initRetryCount = 0;
                this.since = new Date().toISOString();
                log.info('📱 WhatsApp listo.');
                if (this.sessionLostAlerted) {
                    this.sessionLostAlerted = false;
                    this.notifyAlert('🟢 WhatsApp del bot vinculado de nuevo: los envíos al grupo se reanudan.');
                }

                // Resolver ambos grupos (2v2 y 4v4) desde su config de env
                await this.resolveGroups();
                await this.resolveOwnIds();

                this.startKeepAlive();
                this._setState('ready');
                this._emitPairing(null);
                resolve();
            });

            this.client.on('auth_failure', (msg) => {
                log.error({ authMsg: msg }, '❌ Error de autenticación WhatsApp');
                this.ready = false;
                this.status = 'disconnected';
                this.lastError = String(msg || 'auth_failure');
                this._setState('logged_out');
                resolve();
            });

            this.client.on('disconnected', (reason) => {
                log.warn({ reason }, '⚠️  WhatsApp desconectado');
                this.ready = false;
                this.status = 'disconnected';
                this.lastError = String(reason || 'disconnected');
                this._setState(reason === 'LOGOUT' ? 'logged_out' : 'reconnecting');
                if (!this.isRestarting) {
                    log.info('🔄 Intentando reconectar en 5s...');
                    setTimeout(() => this.restart(), 5000);
                }
            });

            // Comandos del grupo. message_create cubre mensajes de otros Y del
            // propio teléfono del bot; el match EXACTO del trigger evita que el
            // bot reaccione a sus propias respuestas.
            this.client.on('message_create', (msg) => {
                this.handleIncomingMessage(msg).catch(err =>
                    log.error({ err }, '❌ Error atendiendo comando WhatsApp')
                );
                // Traducción best-effort a IncomingMessage del contrato (además
                // del despacho real de arriba, no en su lugar): permite que
                // infraestructura nueva (ShadowPort, futuros contract tests)
                // observe los mensajes sin duplicar la lógica de negocio.
                this._emitPortMessage(msg);
            });

            this.client.initialize().catch((error) => {
                log.error({ err: error }, '❌ Error inicializando WhatsApp');
                this.status = 'disconnected';
                this.lastError = String(error?.message || error);
                this.scheduleReconnect();
                resolve();
            });

            // Timeout de seguridad: no bloquear el arranque del servidor
            setTimeout(() => {
                if (!this.ready && !this.isRestarting) {
                    log.warn(`⚠️  WhatsApp timeout (${this.initTimeoutMs / 1000}s) - el servidor sigue sin WhatsApp`);
                    this.scheduleReconnect();
                    resolve();
                }
            }, this.initTimeoutMs);
        });
    }

    async restart() {
        if (!this.enabled || this.isRestarting) return;
        this.isRestarting = true;
        log.info('🔄 Reiniciando servicio de WhatsApp...');
        this.ready = false;
        this.stopKeepAlive();
        await this.destroy();
        await this.initialize();
    }

    startKeepAlive() {
        this.stopKeepAlive();

        this.keepAliveInterval = setInterval(async () => {
            if (!this.ready || !this.client) return;

            try {
                const state = await this.client.getState();
                if (state !== 'CONNECTED') {
                    log.warn(`⚠️  Keep-alive: Estado inesperado (${state}), reiniciando...`);
                    this.restart();
                }
            } catch (error) {
                log.warn({ err: error }, '⚠️  Keep-alive falló, reiniciando...');
                this.restart();
            }
        }, this.keepAliveIntervalMs);

        log.info(`💓 Keep-alive de WhatsApp iniciado (cada ${this.keepAliveIntervalMs / 60000} min)`);
    }

    stopKeepAlive() {
        if (this.keepAliveInterval) {
            clearInterval(this.keepAliveInterval);
            this.keepAliveInterval = null;
        }
    }

    /**
     * chatId configurado para un formato ('2v2' | '4v4').
     * Prioriza el grupo resuelto (verificado contra los chats reales) y cae al
     * ID configurado si aún no se resolvió.
     */
    groupIdFor(format) {
        return this.resolvedGroups[format]?.id || this.groupConfig[format]?.id || null;
    }

    /**
     * Formato del grupo al que pertenece un chatId (inverso de groupIdFor).
     * Parte del contrato MessagingPort.
     */
    formatForChat(chatId) {
        return this.chatIdToFormat[chatId] || null;
    }

    /**
     * Envía una imagen con caption a un chat específico.
     *
     * Dos formas conviven bajo el mismo nombre (se distinguen por el tipo del
     * segundo argumento, nunca ambiguo en la práctica: la forma vieja siempre
     * manda un caption de texto):
     *   - Heredada: `sendImage(imagePath, caption, chatId)` -> boolean, nunca
     *     lanza (la usan report/pipeline.js y jobs/*).
     *   - Contrato MessagingPort: `sendImage(chatId, { path, caption, mentions })`
     *     -> `{id}` o lanza `SendError`.
     */
    async sendImage(a, b, c) {
        if (b !== null && typeof b === 'object') {
            return this._sendImagePort(a, b || {});
        }
        return this._sendImageLegacy(a, b, c);
    }

    /** Forma heredada de sendImage: nunca lanza, boolean. */
    async _sendImageLegacy(imagePath, caption, chatId) {
        if (!this.enabled) return false;

        const isConnected = await this.ensureConnection();
        if (!isConnected) {
            log.warn('⚠️  WhatsApp no está listo para enviar imagen');
            return false;
        }

        if (!chatId) {
            log.warn('⚠️  sendImage sin chatId destino');
            return false;
        }

        const { MessageMedia } = require('whatsapp-web.js');

        for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
            try {
                log.info(`📱 Enviando imagen a WhatsApp (${chatId})... Intento ${attempt}/${this.maxRetries}`);
                const media = MessageMedia.fromFilePath(imagePath);
                await this.client.sendMessage(chatId, media, { caption });
                log.info('📤 Imagen enviada a WhatsApp!');
                return true;
            } catch (error) {
                log.error({ err: error }, `❌ Intento ${attempt}/${this.maxRetries} fallido`);

                if (attempt >= this.maxRetries) {
                    if (error.message.includes('detached Frame') || error.message.includes('Session closed')) {
                        log.warn('⚠️  Error crítico persistente, reiniciando WhatsApp...');
                        this.restart();
                    }
                    return false;
                }

                const retryDelay = this.getRetryDelay(attempt);
                log.info(`   ⏳ Reintentando en ${retryDelay / 1000}s...`);
                await new Promise(resolve => setTimeout(resolve, retryDelay));

                if (!(await this.ensureConnection())) {
                    log.warn('⚠️  Conexión perdida durante reintentos, abortando...');
                    return false;
                }
            }
        }
        return false;
    }

    /** Forma MessagingPort de sendImage: {id} o SendError. */
    async _sendImagePort(chatId, { path: imagePath, caption, mentions } = {}) {
        if (!chatId || !imagePath) throw new SendError('sendImage requiere chatId y path', 'permanent');
        if (!this.isReady()) throw new SendError('WhatsApp no está listo', 'not_ready');
        const ok = await this._sendImageLegacy(imagePath, caption || '', chatId);
        if (!ok) throw new SendError('No se pudo enviar la imagen', 'transient');
        void mentions; // whatsapp-web.js no soporta mentions en mensajes de imagen
        return { id: `sent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` };
    }

    /**
     * Envía un mensaje de texto a un chat específico.
     * @param {string} text
     * @param {string} chatId
     * @param {object} [options] - opciones de whatsapp-web.js (ej. { mentions })
     */
    async sendMessage(text, chatId, options) {
        if (!this.enabled) return false;

        const isConnected = await this.ensureConnection();
        if (!isConnected) return false;
        if (!chatId) return false;

        try {
            await this.client.sendMessage(chatId, text, options);
            return true;
        } catch (error) {
            log.error({ err: error }, '❌ Error enviando mensaje WhatsApp');
            return false;
        }
    }

    /**
     * Forma MessagingPort de un envío de texto: {id} o SendError. Reusa
     * sendMessage (heredado) por dentro; no cambia el comportamiento real.
     */
    async sendText(chatId, text, opts = {}) {
        if (!chatId || !text) throw new SendError('sendText requiere chatId y text', 'permanent');
        if (this.readOnly) throw new SendError('WhatsApp en modo solo-lectura', 'read_only');
        if (!this.isReady()) throw new SendError('WhatsApp no está listo', 'not_ready');
        const ok = await this.sendMessage(text, chatId, opts.mentions ? { mentions: opts.mentions } : undefined);
        if (!ok) throw new SendError('No se pudo enviar el mensaje', 'transient');
        return { id: `sent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` };
    }

    /**
     * IDs propios del bot (wid + su LID), para detectar auto-menciones.
     * El LID se resuelve una sola vez tras conectar; si falla, queda solo el wid.
     */
    async resolveOwnIds() {
        this.ownIds = new Set();
        const wid = this.client?.info?.wid?._serialized;
        if (!wid) return;
        this.ownIds.add(wid);
        for (const pair of await this.resolveLidPn([wid])) {
            if (pair.lid) this.ownIds.add(pair.lid);
            if (pair.pn) this.ownIds.add(pair.pn);
        }
    }

    getOwnIds() {
        return this.ownIds;
    }

    /** Identidad propia del bot, parte del contrato MessagingPort. */
    getSelfIdentity() {
        let identity = {};
        for (const jid of this.ownIds) {
            identity = mergeIdentity(identity, identityFromJid(jid));
        }
        return (identity.pn || identity.lid) ? identity : null;
    }

    /** Token de mención "clásico" (@c.us/@lid) a partir de una Identity. */
    mentionJid(identity) {
        return toLegacyJid(identity) || '';
    }

    /**
     * Puente LID ↔ teléfono de whatsapp-web.js. La misma persona puede llegar
     * como `...@lid` o `521...@c.us`; esto trae ambas formas.
     * Nunca lanza: devuelve [] si el cliente no está listo o el puente falla.
     * @param {string[]} jids
     * @returns {Promise<Array<{lid?:string, pn?:string}>>}
     */
    async resolveLidPn(jids) {
        if (!this.ready || !this.client || !jids?.length) return [];
        try {
            const pairs = await this.client.getContactLidAndPhone(jids);
            return (pairs || []).map(p => ({
                lid: p.lid ? String(p.lid) : undefined,
                pn: p.pn ? String(p.pn) : undefined,
            }));
        } catch (error) {
            log.warn({ err: error }, '⚠️  resolveLidPn falló');
            return [];
        }
    }

    /**
     * Resuelve/enriquece una Identity contra el puente LID↔teléfono. Parte
     * del contrato MessagingPort; por dentro usa resolveLidPn tal cual.
     * Nunca lanza (best effort): en fallo devuelve la identidad de entrada.
     */
    async resolveIdentity(identity, { network = true } = {}) {
        if (!network || !identity) return identity || {};
        const jid = toLegacyJid(identity);
        if (!jid) return identity;
        const [pair] = await this.resolveLidPn([jid]);
        if (!pair) return identity;
        return mergeIdentity(identity, mergeIdentity(identityFromJid(pair.lid), identityFromJid(pair.pn)));
    }

    /**
     * Nombre visible y número de un JID (best effort; nunca lanza).
     * OJO: WhatsApp Web no siempre trae pushname para un contacto pedido por
     * su forma @lid — para eso resolveLidPn ya da la forma @c.us, que sí lo trae.
     * @returns {Promise<{pushname:?string, name:?string, number:?string}>}
     */
    async getContactInfo(jid) {
        if (!this.ready || !this.client || !jid) return {};
        try {
            const contact = await this.client.getContactById(jid);
            return {
                pushname: contact?.pushname || null,
                name: contact?.name || null,
                number: contact?.number || null,
            };
        } catch {
            return {};
        }
    }

    /** Nombre visible de una Identity; parte del contrato MessagingPort. */
    async getDisplayName(identity) {
        const jid = toLegacyJid(identity);
        if (!jid) return null;
        const info = await this.getContactInfo(jid);
        return info.pushname || info.name || null;
    }

    /**
     * Participantes del grupo de un formato, con nombre visible y ambas formas
     * de JID cuando el puente LID↔teléfono responde. Para el bootstrap del roster.
     */
    async getGroupParticipants(format) {
        if (!this.ready || !this.client) return [];
        const groupId = this.groupIdFor(format);
        if (!groupId) return [];

        const chat = await this.client.getChatById(groupId);
        const participants = chat?.participants || [];
        const out = [];
        for (const p of participants) {
            const jid = p.id?._serialized;
            if (!jid) continue;
            const entry = { jid, isAdmin: !!p.isAdmin };
            try {
                const contact = await this.client.getContactById(jid);
                entry.nombre = contact?.pushname || contact?.name || null;
                entry.numero = contact?.number || null;
            } catch { /* sin contacto: solo el JID */ }
            const [pair] = await this.resolveLidPn([jid]);
            if (pair) {
                entry.jidLid = pair.lid || (jid.endsWith('@lid') ? jid : undefined);
                entry.jidPhone = pair.pn || (jid.endsWith('@c.us') ? jid : undefined);
            }
            entry.identity = mergeIdentity(identityFromJid(entry.jidLid), identityFromJid(entry.jidPhone || jid));
            out.push(entry);
        }
        return out;
    }

    /**
     * Registra un comando del grupo. El handler recibe { format, args, msg,
     * mentionedIds, senderId } según el grupo de origen ('2v2' en Retas H3,
     * '4v4' en Torneos Halo 3): format es el formato del grupo, args el texto
     * que sigue al comando, mentionedIds los JIDs etiquetados y senderId el JID
     * de quien lo mandó. Devuelve el texto de respuesta (o falsy para callar).
     */
    registerCommand(trigger, handler) {
        this.commands.set(trigger.toLowerCase(), handler);
        log.info(`💬 Comando WhatsApp registrado: ${trigger}`);
    }

    async handleIncomingMessage(msg) {
        if (!this.ready || this.commands.size === 0) return;

        // El mensaje debe venir de uno de los grupos configurados
        const msgChat = msg.fromMe ? msg.to : msg.from;
        const format = this.chatIdToFormat[msgChat];
        if (!format) return;

        // Primera palabra = comando; el resto = argumentos
        const body = (msg.body || '').trim();
        if (!body.startsWith('!')) return;
        const firstWord = body.split(/\s+/)[0].toLowerCase();
        const handler = this.commands.get(firstWord);
        if (!handler) return;
        const args = body.slice(firstWord.length).trim();

        log.info(`📨 Comando WhatsApp '${firstWord}' recibido en grupo ${format}`);
        // mentionedIds puede traer strings o objetos Wid según el build de
        // WhatsApp Web (la propia librería se cuida de ambos en getMentions).
        const mentionedIds = (msg.mentionedIds || []).map(m =>
            typeof m === 'string' ? m : (m?._serialized || m?.id?._serialized || '')
        ).filter(Boolean);
        const reply = await handler({
            format,
            args,
            msg,
            mentionedIds,
            senderId: msg.author || msg.from,
        });
        if (reply) {
            // El handler puede devolver un string, o { text, mentions } para
            // que la respuesta etiquete gente (tokens "@<dígitos>" en el texto
            // + IDs serializados en options.mentions).
            const text = typeof reply === 'string' ? reply : reply.text;
            const mentions = (typeof reply === 'object' && Array.isArray(reply.mentions) && reply.mentions.length)
                ? reply.mentions.map(String)
                : null;
            if (text) {
                await this.client.sendMessage(msgChat, text, mentions ? { mentions } : undefined);
                log.info(`📤 Respuesta de ${firstWord} enviada a ${format}${mentions ? ` (${mentions.length} menciones)` : ''}`);
            }
        }
    }

    /**
     * Traduce un mensaje nativo de whatsapp-web.js a IncomingMessage y lo
     * emite como evento 'message' del puerto (ver port.js). Best effort:
     * nunca debe tumbar el despacho real de comandos (arriba).
     */
    _emitPortMessage(msg) {
        try {
            const msgChat = msg.fromMe ? msg.to : msg.from;
            const format = this.chatIdToFormat[msgChat] || null;
            const senderJid = msg.author || msg.from;
            const mentionedIds = (msg.mentionedIds || []).map(m =>
                typeof m === 'string' ? m : (m?._serialized || m?.id?._serialized || '')
            ).filter(Boolean);
            this.emit('message', {
                id: msg.id?._serialized || msg.id || `${msgChat}-${msg.timestamp || Date.now()}`,
                chatId: msgChat,
                format,
                fromMe: !!msg.fromMe,
                timestamp: (msg.timestamp ? msg.timestamp * 1000 : Date.now()),
                sender: identityFromJid(senderJid),
                text: msg.body || '',
                mentions: mentionedIds.map(identityFromJid),
                raw: msg,
            });
        } catch (err) {
            log.warn({ err }, '⚠️  No se pudo traducir el mensaje entrante al contrato MessagingPort');
        }
    }

    isReady() {
        return this.enabled && this.ready;
    }

    getQR() {
        return this.currentQR;
    }

    /** Parte del contrato MessagingPort: { qr } o null. */
    getPairing() {
        return this.currentQR ? { qr: this.currentQR } : null;
    }

    async requestPairingCode(phone) {
        if (!this.client || typeof this.client.requestPairingCode !== 'function') {
            throw new NotSupportedError('requestPairingCode()');
        }
        return this.client.requestPairingCode(phone);
    }

    /**
     * Estado para el endpoint admin: disabled | initializing | waiting_qr | ready | disconnected
     */
    getStatus() {
        return {
            status: this.status,
            transport: this.transport,
            groups: {
                '2v2': this.resolvedGroups['2v2'] || null,
                '4v4': this.resolvedGroups['4v4'] || null,
            },
            configured: {
                '2v2': this.groupConfig['2v2'],
                '4v4': this.groupConfig['4v4'],
            }
        };
    }

    /**
     * Lista todos los grupos disponibles (útil para obtener el GROUP_ID)
     */
    async listGroups() {
        if (!this.ready || !this.client) return [];

        try {
            const chats = await this.client.getChats();
            return chats
                .filter(chat => chat.isGroup)
                .map(group => ({
                    id: group.id._serialized,
                    name: group.name,
                    participantsCount: group.participants?.length || 0
                }));
        } catch (error) {
            log.error({ err: error }, '❌ Error listando grupos');
            return [];
        }
    }

    /**
     * Resuelve los grupos configurados (2v2 y 4v4) contra los chats reales,
     * llena resolvedGroups (format -> {id,name}) y chatIdToFormat (inverso).
     */
    async resolveGroups() {
        this.resolvedGroups = {};
        this.chatIdToFormat = {};

        // Siembra desde los IDs configurados en env: los comandos entrantes
        // (chatIdToFormat) y los envíos funcionan aunque getChats() falle —
        // en prod falla a veces justo tras conectar y no hay reintento, lo
        // que dejaba al bot sordo a todos los comandos. getChats() abajo
        // solo verifica pertenencia y refina el nombre visible del grupo.
        for (const format of ['2v2', '4v4']) {
            const cfg = this.groupConfig[format];
            if (cfg?.id) {
                this.resolvedGroups[format] = { id: cfg.id, name: cfg.name || null };
                this.chatIdToFormat[cfg.id] = format;
            }
        }

        if (!this.ready || !this.client) return;

        let groups = [];
        try {
            const chats = await this.client.getChats();
            groups = chats.filter(chat => chat.isGroup);
        } catch (error) {
            log.error({ err: error }, '❌ Error obteniendo chats (los grupos quedan con el ID configurado)');
            return;
        }

        for (const format of ['2v2', '4v4']) {
            const cfg = this.groupConfig[format];
            if (!cfg?.id && !cfg?.name) continue; // formato no configurado

            let match = null;
            if (cfg.id) match = groups.find(g => g.id._serialized === cfg.id);
            if (!match && cfg.name) match = groups.find(g => g.name.toLowerCase() === cfg.name.toLowerCase());

            if (match) {
                const id = match.id._serialized;
                this.resolvedGroups[format] = { id, name: match.name };
                this.chatIdToFormat[id] = format;
                log.info(`📱 Grupo ${format}: ${match.name} (${id})`);
            } else {
                log.warn(`⚠️  Grupo ${format} no encontrado (id/nombre configurado: ${cfg.id || cfg.name})`);
            }
        }

        if (Object.keys(this.resolvedGroups).length === 0) {
            log.warn('⚠️  Ningún grupo de WhatsApp configurado/encontrado.');
            log.warn('   Grupos disponibles:');
            groups.forEach(g => log.warn(`   - ${g.name}: ${g.id._serialized}`));
        }
    }

    async destroy() {
        this.stopKeepAlive();
        if (this.client) {
            try {
                await this.client.destroy();
                log.info('👋 WhatsApp cerrado');
            } catch (error) {
                log.error({ err: error }, 'Error cerrando WhatsApp');
            }
            this.client = null;
        }
    }

    // --- MessagingPort: ciclo de vida genérico (alias de los métodos de arriba) ---

    /** Alias de initialize(), para quien programe contra el contrato MessagingPort. */
    async start() {
        return this.initialize();
    }

    /** Alias de destroy(). */
    async stop() {
        return this.destroy();
    }

    _setState(state) {
        this._portState = state;
        this.emit('status', this.getPortStatus());
    }

    _emitPairing(pairing = this.getPairing()) {
        this.emit('pairing', pairing);
    }

    /**
     * Shape completo del contrato MessagingPort (ver port.js JSDoc). Se deja
     * como método aparte de getStatus() para no romper a health.js ni al
     * endpoint admin, que dependen del shape heredado {status, groups,
     * configured}; getStatus() se queda tal cual.
     */
    getPortStatus() {
        return {
            transport: this.transport,
            state: this._portState || (this.enabled ? 'starting' : 'disabled'),
            since: this.since,
            lastError: this.lastError,
            reconnects: this.reconnects,
            groups: {
                '2v2': this.resolvedGroups['2v2'] || this.groupConfig['2v2'] || null,
                '4v4': this.resolvedGroups['4v4'] || this.groupConfig['4v4'] || null,
            },
            self: this.getSelfIdentity(),
            readOnly: this.readOnly,
        };
    }
}

module.exports = WwebjsPort;
module.exports.WwebjsPort = WwebjsPort;
