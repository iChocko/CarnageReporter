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

    async initialize() {
        if (this.client) {
            console.log('⚠️  WhatsApp ya inicializado, destruyendo sesión anterior...');
            await this.destroy();
        }

        return new Promise((resolve) => {
            const authPath = path.join(__dirname, '..', '.wwebjs_auth');

            // Asegurar que existe el directorio de auth
            if (!fs.existsSync(authPath)) {
                fs.mkdirSync(authPath, { recursive: true });
            }

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

            // Timeout de seguridad
            setTimeout(() => {
                if (!this.ready && !this.isRestarting) {
                    console.log('⚠️  WhatsApp timeout (120s) - continuando sin WhatsApp');
                    resolve();
                }
            }, 120000);
        });
    }

    async restart() {
        if (this.isRestarting) return;
        this.isRestarting = true;
        console.log('🔄 Reiniciando servicio de WhatsApp...');
        this.ready = false;
        await this.destroy();
        await this.initialize();
    }

    async sendImage(imagePath, caption) {
        if (!this.ready) {
            console.log('⚠️  WhatsApp no está listo para enviar imagen');
            return false;
        }

        let retries = 3;
        while (retries > 0) {
            try {
                console.log(`📱 Intentando envío BROWSER-DIRECT (ID: ${this.groupId})... Intentos restantes: ${retries}`);

                // Leer archivo y convertir a base64
                const mediaData = fs.readFileSync(imagePath).toString('base64');
                const mimetype = 'image/png';
                const filename = path.basename(imagePath);

                const result = await this.client.pupPage.evaluate(async (chatId, base64, mimetype, filename, caption) => {
                    try {
                        const chat = window.Store.Chat.get(chatId);
                        if (!chat) return { success: false, error: 'Chat no encontrado en Store' };

                        // PARCHE local en el navegador
                        if (chat.markedUnread === undefined) chat.markedUnread = false;

                        // Llamar a sendMessage con la media sin procesar para que el helper interno haga todo
                        await window.WWebJS.sendMessage(chat, undefined, {
                            media: {
                                data: base64.replace(/\n|\r/g, ''), // Limpiar posibles saltos de línea
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
                console.error(`❌ Intento fallido (${3 - retries + 1}):`, error.message);
                retries--;
                if (retries === 0) {
                    if (error.message.includes('detached Frame') || error.message.includes('markedUnread')) {
                        console.log('⚠️  Error crítico persistente, reiniciando WhatsApp...');
                        this.restart();
                    }
                    return false;
                }
                await new Promise(resolve => setTimeout(resolve, 5000));
            }
        }
    }

    async sendMessage(text) {
        if (!this.ready || !this.targetGroup) {
            return false;
        }

        try {
            await this.client.sendMessage(this.targetGroup.id._serialized, text);
            return true;
        } catch (error) {
            console.error('❌ Error enviando mensaje:', error.message);
            return false;
        }
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
