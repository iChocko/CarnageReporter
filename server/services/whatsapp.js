/**
 * WhatsApp Service
 * Envío de reportes al grupo de WhatsApp vía whatsapp-web.js.
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

class WhatsAppService {
    constructor() {
        this.enabled = process.env.WHATSAPP_ENABLED === 'true';
        this.client = null;
        this.ready = false;
        this.targetGroup = null;
        this.currentQR = null;
        this.status = this.enabled ? 'initializing' : 'disabled';
        this.groupName = process.env.WHATSAPP_GROUP_NAME || null;
        this.groupId = process.env.WHATSAPP_GROUP_ID || null;
        this.authPath = process.env.WHATSAPP_AUTH_DIR || path.join(__dirname, '..', '.wwebjs_auth');
        this.isRestarting = false;
        this.keepAliveInterval = null;
        this.keepAliveIntervalMs = 5 * 60 * 1000; // 5 minutos
        this.initTimeoutMs = 180000; // 180s (VPS lentos)
        this.maxRetries = 5;
        this.baseRetryDelayMs = 1000;

        if (!this.enabled) {
            console.log('📴 WhatsApp deshabilitado (WHATSAPP_ENABLED != true)');
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
                console.log(`🌐 WhatsApp usando Chromium: ${p}`);
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
                        try { fs.unlinkSync(fullPath); } catch (err) { }
                    }
                }
            } catch (err) { }
        };

        cleanDirectory(this.authPath);
    }

    getRetryDelay(attempt) {
        // Backoff exponencial: 1s, 2s, 4s, 8s, 16s (cap 30s)
        return Math.min(this.baseRetryDelayMs * Math.pow(2, attempt - 1), 30000);
    }

    async ensureConnection() {
        if (!this.ready || !this.client) return false;

        try {
            const state = await this.client.getState();
            if (state !== 'CONNECTED') {
                console.log(`⚠️  Estado de WhatsApp: ${state} (esperado: CONNECTED)`);
                return false;
            }
            return true;
        } catch (error) {
            console.log(`⚠️  Verificación de conexión WhatsApp falló: ${error.message}`);
            return false;
        }
    }

    async initialize() {
        if (!this.enabled) return;

        // Cargar deps aquí: si WhatsApp está apagado no se paga el costo de require
        const { Client, LocalAuth } = require('whatsapp-web.js');
        const qrcodeTerminal = require('qrcode-terminal');

        if (this.client) {
            console.log('⚠️  WhatsApp ya inicializado, destruyendo sesión anterior...');
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
                console.log('\n╔════════════════════════════════════════════╗');
                console.log('║     ESCANEA ESTE CÓDIGO QR CON WHATSAPP    ║');
                console.log('║     (Solo necesitas hacerlo UNA VEZ)       ║');
                console.log('╚════════════════════════════════════════════╝');
                console.log('También disponible en: GET /api/admin/whatsapp/qr\n');
                qrcodeTerminal.generate(qr, { small: true });
            });

            this.client.on('authenticated', () => {
                console.log('✅ WhatsApp autenticado');
                this.currentQR = null;
            });

            this.client.on('ready', async () => {
                this.ready = true;
                this.status = 'ready';
                this.currentQR = null;
                this.isRestarting = false;
                console.log('📱 WhatsApp listo.');

                // Resolver el grupo destino desde env (ID o nombre)
                const result = await this.setTargetGroup(this.groupId, this.groupName);
                if (!result.success) {
                    console.log(`⚠️  ${result.message}`);
                    if (result.availableGroups?.length) {
                        console.log('   Grupos disponibles:');
                        result.availableGroups.forEach(g => console.log(`   - ${g.name}: ${g.id}`));
                    }
                }

                this.startKeepAlive();
                resolve();
            });

            this.client.on('auth_failure', (msg) => {
                console.error('❌ Error de autenticación WhatsApp:', msg);
                this.ready = false;
                this.status = 'disconnected';
                resolve();
            });

            this.client.on('disconnected', (reason) => {
                console.log('⚠️  WhatsApp desconectado:', reason);
                this.ready = false;
                this.status = 'disconnected';
                if (!this.isRestarting) {
                    console.log('🔄 Intentando reconectar en 5s...');
                    setTimeout(() => this.restart(), 5000);
                }
            });

            this.client.initialize().catch((error) => {
                console.error('❌ Error inicializando WhatsApp:', error.message);
                this.status = 'disconnected';
                resolve();
            });

            // Timeout de seguridad: no bloquear el arranque del servidor
            setTimeout(() => {
                if (!this.ready && !this.isRestarting) {
                    console.log(`⚠️  WhatsApp timeout (${this.initTimeoutMs / 1000}s) - el servidor sigue sin WhatsApp`);
                    resolve();
                }
            }, this.initTimeoutMs);
        });
    }

    async restart() {
        if (!this.enabled || this.isRestarting) return;
        this.isRestarting = true;
        console.log('🔄 Reiniciando servicio de WhatsApp...');
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
                    console.log(`⚠️  Keep-alive: Estado inesperado (${state}), reiniciando...`);
                    this.restart();
                }
            } catch (error) {
                console.log(`⚠️  Keep-alive falló: ${error.message}, reiniciando...`);
                this.restart();
            }
        }, this.keepAliveIntervalMs);

        console.log(`💓 Keep-alive de WhatsApp iniciado (cada ${this.keepAliveIntervalMs / 60000} min)`);
    }

    stopKeepAlive() {
        if (this.keepAliveInterval) {
            clearInterval(this.keepAliveInterval);
            this.keepAliveInterval = null;
        }
    }

    /**
     * Envía una imagen con caption al grupo destino.
     * Nunca lanza: devuelve false en fallo (no debe tumbar /api/report).
     */
    async sendImage(imagePath, caption) {
        if (!this.enabled) return false;

        const isConnected = await this.ensureConnection();
        if (!isConnected) {
            console.log('⚠️  WhatsApp no está listo para enviar imagen');
            return false;
        }

        const chatId = this.targetGroup?.id?._serialized || this.groupId;
        if (!chatId) {
            console.log('⚠️  WhatsApp sin grupo destino (configura WHATSAPP_GROUP_ID o WHATSAPP_GROUP_NAME)');
            return false;
        }

        const { MessageMedia } = require('whatsapp-web.js');

        for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
            try {
                console.log(`📱 Enviando imagen a WhatsApp (${chatId})... Intento ${attempt}/${this.maxRetries}`);
                const media = MessageMedia.fromFilePath(imagePath);
                await this.client.sendMessage(chatId, media, { caption });
                console.log('📤 Imagen enviada a WhatsApp!');
                return true;
            } catch (error) {
                console.error(`❌ Intento ${attempt}/${this.maxRetries} fallido: ${error.message}`);

                if (attempt >= this.maxRetries) {
                    if (error.message.includes('detached Frame') || error.message.includes('Session closed')) {
                        console.log('⚠️  Error crítico persistente, reiniciando WhatsApp...');
                        this.restart();
                    }
                    return false;
                }

                const retryDelay = this.getRetryDelay(attempt);
                console.log(`   ⏳ Reintentando en ${retryDelay / 1000}s...`);
                await new Promise(resolve => setTimeout(resolve, retryDelay));

                if (!(await this.ensureConnection())) {
                    console.log('⚠️  Conexión perdida durante reintentos, abortando...');
                    return false;
                }
            }
        }
        return false;
    }

    async sendMessage(text) {
        if (!this.enabled) return false;

        const isConnected = await this.ensureConnection();
        if (!isConnected) return false;

        const chatId = this.targetGroup?.id?._serialized || this.groupId;
        if (!chatId) return false;

        try {
            await this.client.sendMessage(chatId, text);
            return true;
        } catch (error) {
            console.error('❌ Error enviando mensaje WhatsApp:', error.message);
            return false;
        }
    }

    isReady() {
        return this.enabled && this.ready;
    }

    getQR() {
        return this.currentQR;
    }

    /**
     * Estado para el endpoint admin: disabled | initializing | waiting_qr | ready | disconnected
     */
    getStatus() {
        return {
            status: this.status,
            group: this.targetGroup ? { id: this.targetGroup.id._serialized, name: this.targetGroup.name } : null,
            configuredGroupId: this.groupId,
            configuredGroupName: this.groupName
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
            console.error('❌ Error listando grupos:', error.message);
            return [];
        }
    }

    /**
     * Cambia el grupo de destino por ID (preciso) o por nombre
     */
    async setTargetGroup(groupId, groupName) {
        if (!this.ready || !this.client) {
            return { success: false, message: 'WhatsApp no está listo' };
        }

        if (!groupId && !groupName) {
            return { success: false, message: 'Sin grupo configurado (WHATSAPP_GROUP_ID / WHATSAPP_GROUP_NAME)' };
        }

        try {
            const chats = await this.client.getChats();
            const groups = chats.filter(chat => chat.isGroup);

            let newGroup = null;
            if (groupId) {
                newGroup = groups.find(g => g.id._serialized === groupId);
            }
            if (!newGroup && groupName) {
                newGroup = groups.find(g => g.name.toLowerCase() === groupName.toLowerCase());
            }

            if (newGroup) {
                this.targetGroup = newGroup;
                console.log(`📱 Grupo destino: ${newGroup.name} (${newGroup.id._serialized})`);
                return { success: true, groupId: newGroup.id._serialized, groupName: newGroup.name };
            }

            return {
                success: false,
                message: `Grupo no encontrado: ${groupId || groupName}`,
                availableGroups: groups.map(g => ({ id: g.id._serialized, name: g.name }))
            };
        } catch (error) {
            console.error('❌ Error cambiando grupo:', error.message);
            return { success: false, message: error.message };
        }
    }

    async destroy() {
        this.stopKeepAlive();
        if (this.client) {
            try {
                await this.client.destroy();
                console.log('👋 WhatsApp cerrado');
            } catch (error) {
                console.error('Error cerrando WhatsApp:', error.message);
            }
            this.client = null;
        }
    }
}

module.exports = WhatsAppService;
