/**
 * WhatsApp Service
 * Gestión centralizada de WhatsApp para el servidor
 */

const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const path = require('path');
const fs = require('fs');

class WhatsAppService {
    constructor() {
        this.client = null;
        this.ready = false;
        this.targetGroup = null;
        this.currentQR = null;
        this.groupName = process.env.WHATSAPP_GROUP_NAME || 'H3MCC';
        this.groupId = process.env.WHATSAPP_GROUP_ID || null;
        this.executablePath = this.getChromiumPath();
        this.isRestarting = false;
        this.keepAliveInterval = null;
        this.keepAliveIntervalMs = 5 * 60 * 1000; // 5 minutos
        this.initTimeoutMs = 180000; // 180s para VPS (antes 120s)
        this.maxRetries = 5; // 5 intentos con backoff exponencial
        this.baseRetryDelayMs = 1000; // Delay base de 1 segundo
    }

    /**
     * Detecta la ruta de Chromium en el sistema
     * Prioriza Snap (Ubuntu 24.04) sobre otras instalaciones
     */
    getChromiumPath() {
        const possiblePaths = [
            '/snap/bin/chromium',                    // Ubuntu 24.04 Snap (PRIORITARIO)
            '/usr/bin/chromium-browser',             // Debian/Ubuntu apt
            '/usr/bin/chromium',                     // Algunas distros
            '/usr/bin/google-chrome-stable',         // Chrome instalado
            '/usr/bin/google-chrome',
        ];

        for (const p of possiblePaths) {
            if (fs.existsSync(p)) {
                console.log(`🌐 WhatsApp usando Chromium: ${p}`);
                return p;
            }
        }

        // Fallback: usar variable de entorno o dejar que Puppeteer use su binario
        return process.env.PUPPETEER_EXECUTABLE_PATH || null;
    }

    /**
     * Limpia archivos de bloqueo de Chromium/Puppeteer al iniciar
     * Estos archivos pueden quedar huérfanos si el proceso terminó abruptamente
     */
    cleanupLockFiles() {
        const authPath = path.join(__dirname, '..', '.wwebjs_auth_v4');

        if (!fs.existsSync(authPath)) {
            return;
        }

        const lockPatterns = [
            'SingletonLock',
            'SingletonCookie',
            'SingletonSocket',
            '.org.chromium.Chromium.lock'
        ];

        console.log('🧹 Limpiando archivos de bloqueo...');
        let cleanedCount = 0;

        const cleanDirectory = (dir) => {
            try {
                const items = fs.readdirSync(dir, { withFileTypes: true });

                for (const item of items) {
                    const fullPath = path.join(dir, item.name);

                    if (item.isDirectory()) {
                        // Recursivamente limpiar subdirectorios
                        cleanDirectory(fullPath);
                    } else if (lockPatterns.some(pattern => item.name.includes(pattern))) {
                        try {
                            fs.unlinkSync(fullPath);
                            console.log(`   🗑️  Eliminado: ${item.name}`);
                            cleanedCount++;
                        } catch (err) {
                            console.log(`   ⚠️  No se pudo eliminar ${item.name}: ${err.message}`);
                        }
                    }
                }
            } catch (err) {
                // Directorio puede no existir o no ser accesible
            }
        };

        cleanDirectory(authPath);

        if (cleanedCount > 0) {
            console.log(`🧹 Limpieza completada: ${cleanedCount} archivo(s) de bloqueo eliminado(s)`);
        } else {
            console.log('🧹 No se encontraron archivos de bloqueo');
        }
    }

    /**
     * Calcula el delay con backoff exponencial
     * @param {number} attempt - Número de intento (1-based)
     * @returns {number} Delay en milisegundos
     */
    getRetryDelay(attempt) {
        // Backoff exponencial: 1s, 2s, 4s, 8s, 16s
        const delay = this.baseRetryDelayMs * Math.pow(2, attempt - 1);
        // Cap máximo de 30 segundos
        return Math.min(delay, 30000);
    }

    /**
     * Verifica que la conexión esté activa antes de enviar
     * @returns {boolean} true si la conexión está lista
     */
    async ensureConnection() {
        if (!this.ready || !this.client) {
            console.log('⚠️  WhatsApp no está listo');
            return false;
        }

        try {
            // Verificar estado de conexión
            const state = await this.client.getState();
            if (state !== 'CONNECTED') {
                console.log(`⚠️  Estado de WhatsApp: ${state} (esperado: CONNECTED)`);
                return false;
            }

            // Verificar que pupPage sigue activo
            await this.client.pupPage.evaluate(() => true);
            return true;
        } catch (error) {
            console.log(`⚠️  Verificación de conexión falló: ${error.message}`);
            return false;
        }
    }

    async initialize() {
        if (this.client) {
            console.log('⚠️  WhatsApp ya inicializado, destruyendo sesión anterior...');
            await this.destroy();
        }

        return new Promise((resolve) => {
            const authPath = path.join(__dirname, '..', '.wwebjs_auth_v4');

            // Asegurar que existe el directorio de auth
            if (!fs.existsSync(authPath)) {
                fs.mkdirSync(authPath, { recursive: true });
            }

            // Limpiar archivos de bloqueo huérfanos
            this.cleanupLockFiles();

            // Configuración de Puppeteer optimizada para Snap Chromium
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

            // Usar Chromium del sistema si está disponible
            if (this.executablePath) {
                puppeteerConfig.executablePath = this.executablePath;
            }

            this.client = new Client({
                authStrategy: new LocalAuth({
                    dataPath: authPath
                }),
                puppeteer: puppeteerConfig
            });

            this.client.on('qr', (qr) => {
                this.currentQR = qr;
                console.log('\n╔════════════════════════════════════════════╗');
                console.log('║     ESCANEA ESTE CÓDIGO QR CON WHATSAPP    ║');
                console.log('║     (Solo necesitas hacerlo UNA VEZ)       ║');
                console.log('╚════════════════════════════════════════════╝\n');
                console.log(`\n[${new Date().toISOString()}] QR Recibido:`);
                qrcode.generate(qr, { small: true });
                console.log('\n');
            });

            this.client.on('authenticated', () => {
                console.log('✅ WhatsApp autenticado');
                this.currentQR = null;
            });

            this.client.on('ready', async () => {
                console.log(`📱 WhatsApp listo. Usando Group ID: ${this.groupId}`);
                this.ready = true;
                this.currentQR = null;
                this.isRestarting = false;
                this.startKeepAlive();
                resolve();
            });

            this.client.on('auth_failure', (msg) => {
                console.error('❌ Error de autenticación WhatsApp:', msg);
                this.ready = false;
                resolve();
            });

            this.client.on('disconnected', (reason) => {
                console.log('⚠️  WhatsApp desconectado:', reason);
                this.ready = false;
                if (!this.isRestarting) {
                    console.log('🔄 Intentando reconectar en 5s...');
                    setTimeout(() => this.restart(), 5000);
                }
            });

            this.client.initialize().catch((error) => {
                console.error('❌ Error inicializando WhatsApp:', error.message);
                resolve();
            });

            // Timeout de seguridad (más largo para VPS)
            setTimeout(() => {
                if (!this.ready && !this.isRestarting) {
                    console.log(`⚠️  WhatsApp timeout (${this.initTimeoutMs / 1000}s) - continuando sin WhatsApp`);
                    resolve();
                }
            }, this.initTimeoutMs);
        });
    }

    async restart() {
        if (this.isRestarting) return;
        this.isRestarting = true;
        console.log('🔄 Reiniciando servicio de WhatsApp...');
        this.ready = false;
        this.stopKeepAlive();
        await this.destroy();
        await this.initialize();
    }

    /**
     * Inicia el keep-alive para mantener la conexión activa
     * Hace un ping cada 5 minutos para detectar desconexiones antes de que fallen envíos
     */
    startKeepAlive() {
        this.stopKeepAlive(); // Limpiar intervalo anterior si existe

        this.keepAliveInterval = setInterval(async () => {
            if (!this.ready || !this.client) return;

            try {
                // Verificar que el browser sigue conectado
                const state = await this.client.getState();
                if (state !== 'CONNECTED') {
                    console.log(`⚠️  Keep-alive: Estado inesperado (${state}), reiniciando...`);
                    this.restart();
                    return;
                }

                // Verificar que pupPage sigue activo con una operación ligera
                await this.client.pupPage.evaluate(() => true);
                console.log(`💓 Keep-alive: WhatsApp OK (${new Date().toLocaleTimeString()})`);
            } catch (error) {
                console.log(`⚠️  Keep-alive falló: ${error.message}, reiniciando...`);
                this.restart();
            }
        }, this.keepAliveIntervalMs);

        console.log(`💓 Keep-alive iniciado (cada ${this.keepAliveIntervalMs / 60000} minutos)`);
    }

    /**
     * Detiene el keep-alive
     */
    stopKeepAlive() {
        if (this.keepAliveInterval) {
            clearInterval(this.keepAliveInterval);
            this.keepAliveInterval = null;
        }
    }

    async sendImage(imagePath, caption) {
        // Verificación de conexión antes de enviar
        const isConnected = await this.ensureConnection();
        if (!isConnected) {
            console.log('⚠️  WhatsApp no está listo para enviar imagen');
            return false;
        }

        let attempt = 0;
        while (attempt < this.maxRetries) {
            attempt++;
            try {
                console.log(`📱 Intentando envío BROWSER-DIRECT (ID: ${this.groupId})... Intento ${attempt}/${this.maxRetries}`);

                // Leer archivo y convertir a base64
                const mediaBuffer = fs.readFileSync(imagePath);
                const mediaData = mediaBuffer.toString('base64');
                const mimetype = 'image/png';
                const filename = path.basename(imagePath);

                console.log(`   📦 Preparando envío: ${filename} (${mediaBuffer.length} bytes), Caption: ${caption.split('\n')[0]}...`);

                const result = await this.client.pupPage.evaluate(async (chatId, base64, mimetype, filename, caption) => {
                    try {
                        const chat = window.Store.Chat.get(chatId);
                        if (!chat) return { success: false, error: 'Chat no encontrado en Store' };

                        // Limpiar base64 de cualquier carácter no válido para atob
                        const cleanBase64 = base64.replace(/[^A-Za-z0-9+/=]/g, '');

                        if (chat.markedUnread === undefined) chat.markedUnread = false;

                        await window.WWebJS.sendMessage(chat, undefined, {
                            media: {
                                data: cleanBase64,
                                mimetype: mimetype,
                                filename: filename
                            },
                            caption: caption
                        });

                        return { success: true };
                    } catch (e) {
                        return { success: false, error: (e.stack || e.message) };
                    }
                }, this.groupId, mediaData, mimetype, filename, caption);

                if (result.success) {
                    console.log('📤 Imagen enviada a WhatsApp exitosamente (vía Browser Direct)!');
                    return true;
                } else {
                    throw new Error(result.error);
                }
            } catch (error) {
                const retryDelay = this.getRetryDelay(attempt);
                console.error(`❌ Intento ${attempt}/${this.maxRetries} fallido: ${error.message}`);

                if (attempt >= this.maxRetries) {
                    if (error.message.includes('detached Frame') || error.message.includes('markedUnread')) {
                        console.log('⚠️  Error crítico persistente, reiniciando WhatsApp...');
                        this.restart();
                    }
                    return false;
                }

                console.log(`   ⏳ Reintentando en ${retryDelay / 1000}s (backoff exponencial)...`);
                await new Promise(resolve => setTimeout(resolve, retryDelay));

                // Re-verificar conexión antes del siguiente intento
                const stillConnected = await this.ensureConnection();
                if (!stillConnected) {
                    console.log('⚠️  Conexión perdida durante reintentos, abortando...');
                    return false;
                }
            }
        }
        return false;
    }

    async sendMessage(text) {
        if (!this.targetGroup) {
            console.log('⚠️  No hay grupo objetivo configurado');
            return false;
        }

        // Verificación de conexión antes de enviar
        const isConnected = await this.ensureConnection();
        if (!isConnected) {
            console.log('⚠️  WhatsApp no está listo para enviar mensaje');
            return false;
        }

        let attempt = 0;
        while (attempt < this.maxRetries) {
            attempt++;
            try {
                await this.client.sendMessage(this.targetGroup.id._serialized, text);
                return true;
            } catch (error) {
                const retryDelay = this.getRetryDelay(attempt);
                console.error(`❌ Error enviando mensaje (intento ${attempt}/${this.maxRetries}):`, error.message);

                if (attempt >= this.maxRetries) {
                    return false;
                }

                console.log(`   ⏳ Reintentando en ${retryDelay / 1000}s...`);
                await new Promise(resolve => setTimeout(resolve, retryDelay));
            }
        }
        return false;
    }

    isReady() {
        return this.ready;
    }

    getQR() {
        return this.currentQR;
    }

    getGroupName() {
        return this.targetGroup ? this.targetGroup.name : null;
    }

    /**
     * Obtiene información completa del grupo actual
     */
    getGroupInfo() {
        if (!this.targetGroup) return null;
        return {
            id: this.targetGroup.id._serialized,
            name: this.targetGroup.name
        };
    }

    /**
     * Lista todos los grupos disponibles
     * @returns {Array} Lista de grupos con id y nombre
     */
    async listGroups() {
        if (!this.ready || !this.client) {
            return [];
        }

        try {
            const chats = await this.client.getChats();
            const groups = chats
                .filter(chat => chat.isGroup)
                .map(group => ({
                    id: group.id._serialized,
                    name: group.name,
                    participantsCount: group.participants?.length || 0
                }));

            return groups;
        } catch (error) {
            console.error('❌ Error listando grupos:', error.message);
            return [];
        }
    }

    /**
     * Cambia el grupo de destino
     * @param {string} groupId - ID del grupo (ej: "123456789@g.us")
     * @param {string} groupName - Nombre del grupo (alternativa al ID)
     * @returns {Object} Resultado de la operación
     */
    async setTargetGroup(groupId, groupName) {
        if (!this.ready || !this.client) {
            return { success: false, message: 'WhatsApp no está listo' };
        }

        try {
            const chats = await this.client.getChats();
            const groups = chats.filter(chat => chat.isGroup);

            let newGroup = null;

            // Buscar por ID primero (más preciso)
            if (groupId) {
                newGroup = groups.find(g => g.id._serialized === groupId);
            }

            // Si no se encuentra por ID, buscar por nombre
            if (!newGroup && groupName) {
                newGroup = groups.find(g =>
                    g.name.toLowerCase() === groupName.toLowerCase()
                );
            }

            if (newGroup) {
                this.targetGroup = newGroup;
                this.groupName = newGroup.name;
                console.log(`📱 Grupo cambiado a: ${newGroup.name} (${newGroup.id._serialized})`);
                return {
                    success: true,
                    groupId: newGroup.id._serialized,
                    groupName: newGroup.name
                };
            } else {
                return {
                    success: false,
                    message: `Grupo no encontrado: ${groupId || groupName}`,
                    availableGroups: groups.map(g => ({
                        id: g.id._serialized,
                        name: g.name
                    }))
                };
            }
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
        }
    }
}

module.exports = WhatsAppService;
