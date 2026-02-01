/**
 * Cliente Simulado de Halo 3 MCC
 * Monitorea directorio temporal y envía stats al servidor
 */

const fs = require('fs');
const path = require('path');
const http = require('http');

class MCCClient {
    constructor(config = {}) {
        this.tempDir = config.tempDir || path.join(__dirname, 'temp');
        this.serverHost = config.serverHost || 'localhost';
        this.serverPort = config.serverPort || 3000;
        this.apiKey = config.apiKey || 'h3mcc-carnage-2024-secret';
        this.pollInterval = config.pollInterval || 1500; // 1.5 segundos

        this.processedFiles = new Set();
        this.isMonitoring = false;
        this.monitoringInterval = null;
        this.stats = {
            detected: 0,
            processed: 0,
            failed: 0
        };
    }

    /**
     * Inicializa el cliente
     */
    async init() {
        console.log('╔══════════════════════════════════════════════════════════╗');
        console.log('║          HALO 3 MCC CLIENT SIMULATOR                     ║');
        console.log('╚══════════════════════════════════════════════════════════╝\n');

        console.log(`📁 Directorio temporal: ${this.tempDir}`);
        console.log(`🌐 Servidor: ${this.serverHost}:${this.serverPort}`);
        console.log(`⏱️  Intervalo de monitoreo: ${this.pollInterval}ms`);

        // Crear directorio temporal si no existe
        if (!fs.existsSync(this.tempDir)) {
            fs.mkdirSync(this.tempDir, { recursive: true });
            console.log('✅ Directorio temporal creado');
        }

        // Limpiar archivos antiguos
        this.cleanTempDirectory();
    }

    /**
     * Limpia archivos temporales antiguos
     */
    cleanTempDirectory() {
        console.log('\n🧹 Limpiando archivos temporales antiguos...');

        const files = fs.readdirSync(this.tempDir);
        const xmlFiles = files.filter(f => f.endsWith('.xml') || f.endsWith('.json'));

        if (xmlFiles.length === 0) {
            console.log('   ✅ No hay archivos antiguos');
            return;
        }

        xmlFiles.forEach(file => {
            const filePath = path.join(this.tempDir, file);
            fs.unlinkSync(filePath);
            console.log(`   🗑️  Eliminado: ${file}`);
        });

        console.log(`   ✅ ${xmlFiles.length} archivo(s) limpiado(s)\n`);
    }

    /**
     * Inicia el monitoreo de archivos
     */
    startMonitoring() {
        if (this.isMonitoring) {
            console.log('⚠️  El monitoreo ya está activo');
            return;
        }

        console.log('\n👀 Iniciando monitoreo de archivos...');
        console.log('   Esperando nuevas partidas...\n');

        this.isMonitoring = true;

        // Polling cada X segundos
        this.monitoringInterval = setInterval(() => {
            this.checkForNewFiles();
        }, this.pollInterval);
    }

    /**
     * Detiene el monitoreo
     */
    stopMonitoring() {
        if (this.monitoringInterval) {
            clearInterval(this.monitoringInterval);
            this.monitoringInterval = null;
        }
        this.isMonitoring = false;
        console.log('\n🛑 Monitoreo detenido');
    }

    /**
     * Verifica si hay nuevos archivos
     */
    checkForNewFiles() {
        try {
            const files = fs.readdirSync(this.tempDir);
            const matchFiles = files.filter(f => f.endsWith('.json') && !this.processedFiles.has(f));

            matchFiles.forEach(file => {
                this.processFile(file);
            });
        } catch (error) {
            console.error('❌ Error verificando archivos:', error.message);
        }
    }

    /**
     * Procesa un archivo de partida
     */
    async processFile(filename) {
        const filePath = path.join(this.tempDir, filename);

        console.log(`\n📥 Nuevo archivo detectado: ${filename}`);
        console.log(`   ⏰ ${new Date().toLocaleTimeString()}`);

        this.stats.detected++;
        this.processedFiles.add(filename);

        try {
            // Leer archivo
            const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            console.log(`   📄 Datos cargados: ${data.gameData.mapName} - ${data.gameData.gameTypeName}`);

            // Enviar al servidor
            const success = await this.sendToServer(data);

            if (success) {
                this.stats.processed++;
                console.log('   ✅ Partida enviada y procesada correctamente');

                // Eliminar archivo procesado (simula comportamiento de MCC)
                fs.unlinkSync(filePath);
                console.log('   🗑️  Archivo temporal eliminado');
            } else {
                this.stats.failed++;
                console.log('   ❌ Error al procesar partida');
            }

        } catch (error) {
            console.error('   ❌ Error procesando archivo:', error.message);
            this.stats.failed++;
        }
    }

    /**
     * Envía datos al servidor
     */
    async sendToServer(matchData) {
        return new Promise((resolve) => {
            const data = JSON.stringify(matchData);

            const options = {
                hostname: this.serverHost,
                port: this.serverPort,
                path: '/api/report',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-API-Key': this.apiKey,
                    'Content-Length': data.length
                }
            };

            console.log(`   📤 Enviando al servidor...`);

            const req = http.request(options, (res) => {
                let responseBody = '';

                res.on('data', (chunk) => {
                    responseBody += chunk;
                });

                res.on('end', () => {
                    if (res.statusCode === 200) {
                        try {
                            const response = JSON.parse(responseBody);
                            if (response.status === 'processed') {
                                resolve(true);
                            } else if (response.status === 'duplicate') {
                                console.log('   ⏭️  Partida duplicada, saltando');
                                resolve(true);
                            } else {
                                console.log('   ⚠️  Respuesta inesperada:', response);
                                resolve(false);
                            }
                        } catch (e) {
                            console.log('   ⚠️  Error parseando respuesta');
                            resolve(false);
                        }
                    } else {
                        console.log(`   ❌ Error HTTP ${res.statusCode}`);
                        resolve(false);
                    }
                });
            });

            req.on('error', (error) => {
                console.log(`   ❌ Error de conexión: ${error.message}`);
                resolve(false);
            });

            req.write(data);
            req.end();
        });
    }

    /**
     * Muestra estadísticas del cliente
     */
    showStats() {
        console.log('\n\n╔══════════════════════════════════════════════════════════╗');
        console.log('║              ESTADÍSTICAS DEL CLIENTE                    ║');
        console.log('╚══════════════════════════════════════════════════════════╝\n');

        console.log(`📊 Archivos detectados: ${this.stats.detected}`);
        console.log(`✅ Partidas procesadas: ${this.stats.processed}`);
        console.log(`❌ Errores: ${this.stats.failed}`);
        console.log(`📈 Tasa de éxito: ${this.stats.detected > 0 ?
            ((this.stats.processed / this.stats.detected) * 100).toFixed(1) : 0}%\n`);
    }
}

module.exports = MCCClient;
