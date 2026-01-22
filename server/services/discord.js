/**
 * Discord Service
 * Envío de imágenes y mensajes a Discord via webhook
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

class DiscordService {
    constructor() {
        this.webhookUrl = process.env.DISCORD_WEBHOOK_URL;
    }

    /**
     * Cambia el webhook de Discord dinámicamente
     * @param {string} url - Nueva URL del webhook
     */
    setWebhookUrl(url) {
        this.webhookUrl = url;
        console.log(`💬 Discord webhook actualizado`);
    }

    /**
     * Obtiene el webhook actual (oculta parte de la URL por seguridad)
     */
    getWebhookInfo() {
        if (!this.webhookUrl) return null;
        const url = new URL(this.webhookUrl);
        return `${url.hostname}${url.pathname.slice(0, 30)}...`;
    }

    async sendImage(imagePath, gameData, players) {
        if (!this.webhookUrl) {
            console.log('⚠️  Discord webhook no configurado');
            return false;
        }

        const caption = `🏆 **${gameData.mapName}** - ${gameData.gameTypeName}\n📅 ${new Date(gameData.timestamp).toLocaleString()}\nID: \`${gameData.gameUniqueId}\``;

        try {
            const boundary = '----WebKitFormBoundary7MA4YWxkTrZu0gW';
            const filename = path.basename(imagePath);
            const fileData = fs.readFileSync(imagePath);

            const payload = Buffer.concat([
                Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="content"\r\n\r\n${caption}\r\n`),
                Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: image/png\r\n\r\n`),
                fileData,
                Buffer.from(`\r\n--${boundary}--\r\n`)
            ]);

            const url = new URL(this.webhookUrl);
            const options = {
                hostname: url.hostname,
                path: url.pathname,
                method: 'POST',
                headers: {
                    'Content-Type': `multipart/form-data; boundary=${boundary}`,
                    'Content-Length': payload.length
                }
            };

            return new Promise((resolve) => {
                const req = https.request(options, (res) => {
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        console.log('📤 Imagen enviada a Discord!');
                        resolve(true);
                    } else {
                        console.error(`❌ Discord falló con status ${res.statusCode}`);
                        this.sendFallbackText(gameData, players).then(resolve);
                    }
                });

                req.on('error', (e) => {
                    console.error('❌ Error enviando a Discord:', e.message);
                    this.sendFallbackText(gameData, players).then(resolve);
                });

                req.write(payload);
                req.end();
            });
        } catch (error) {
            console.error('❌ Error en sendImage:', error.message);
            return this.sendFallbackText(gameData, players);
        }
    }

    async sendFallbackText(gameData, players) {
        if (!this.webhookUrl) return false;

        let table = `**STATS: ${gameData.mapName} (${gameData.gameTypeName})**\n`;
        table += '```\n';
        table += 'Player          | K   | D   | A   | Score\n';
        table += '----------------|-----|-----|-----|-------\n';

        players.sort((a, b) => b.score - a.score).forEach(p => {
            const name = p.gamertag.padEnd(15).slice(0, 15);
            const k = p.kills.toString().padEnd(3);
            const d = p.deaths.toString().padEnd(3);
            const a = p.assists.toString().padEnd(3);
            const s = p.score.toString().padEnd(5);
            table += `${name} | ${k} | ${d} | ${a} | ${s}\n`;
        });
        table += '```';

        const payload = JSON.stringify({ content: table });
        const url = new URL(this.webhookUrl);
        const options = {
            hostname: url.hostname,
            path: url.pathname,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload)
            }
        };

        return new Promise((resolve) => {
            const req = https.request(options, () => {
                console.log('📤 Tabla de texto enviada a Discord (Fallback)');
                resolve(true);
            });
            req.on('error', (e) => {
                console.error('❌ Error enviando fallback:', e.message);
                resolve(false);
            });
            req.write(payload);
            req.end();
        });
    }

    async sendMessage(text) {
        if (!this.webhookUrl) return false;

        const payload = JSON.stringify({ content: text });
        const url = new URL(this.webhookUrl);
        const options = {
            hostname: url.hostname,
            path: url.pathname,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload)
            }
        };

        return new Promise((resolve) => {
            const req = https.request(options, (res) => {
                resolve(res.statusCode >= 200 && res.statusCode < 300);
            });
            req.on('error', () => resolve(false));
            req.write(payload);
            req.end();
        });
    }
}

module.exports = DiscordService;
