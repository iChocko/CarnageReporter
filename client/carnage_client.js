/**
 * CarnageReporter Client
 * Cliente ligero que monitorea archivos XML y los envía al servidor
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');
const { XMLParser } = require('fast-xml-parser');
const chokidar = require('chokidar');

// ============== CONFIGURACIÓN ==============

const CONFIG = {
    serverUrl: process.env.SERVER_URL || 'https://h3mccstats.cloud',
    apiKey: process.env.API_KEY || 'h3mcc-carnage-2024-secret',

    // Mapeo de nombres de mapas (Colección expandida de Halo 3)
    maps: {
        'asq_chill': 'Narrows',
        'asq_constru': 'Construct',
        'asq_guardia': 'Guardian',
        'asq_cyberdy': 'The Pit',
        'asq_warehou': 'Foundry (Onslaught)',
        'asq_midship': 'Heretic',
        'asq_epitaph': 'Epitaph',
        'asq_high_ground': 'High Ground',
        'asq_isolation': 'Isolation',
        'asq_last_resort': 'Last Resort',
        'asq_sandtrap': 'Sandtrap',
        'asq_snowbound': 'Snowbound',
        'asq_the_pit': 'The Pit',
        'asq_valhalla': 'Valhalla',
        'asq_blackout': 'Blackout',
        'asq_ghost_town': 'Ghost Town',
        'asq_rat_nest': 'Rat\'s Nest',
        'asq_standoff': 'Standoff',
        'asq_avalanche': 'Avalanche',
        'asq_foundry': 'Foundry',
        'asq_boundless': 'Snowbound (Boundless)',
        'asq_glacier': 'Cold Storage',
        'asq_orbital': 'Orbital',
        'asq_assembly': 'Assembly',
        'asq_citadel': 'Citadel',
        'asq_heretic': 'Heretic',
        'asq_longshore': 'Longshore',
        'asq_sandbox': 'Sandbox',
        'asq_tundra': 'Avalanche',
        'asq_descent': 'Assembly',
    }
};

// ============== UTILIDADES ==============

function getMapName(filename, gameData = {}) {
    const fn = filename.toLowerCase();
    for (const [key, val] of Object.entries(CONFIG.maps)) {
        if (fn.includes(key)) return val;
    }

    if (gameData.hopperName && gameData.hopperName !== 'Unknown' && gameData.hopperName !== '') {
        return gameData.hopperName;
    }

    if (fn.includes('mpcarnagereport')) return 'Halo 3 Match';
    return 'Halo 3 Map';
}

function getMCCTempPath() {
    const windowsPath = path.join(os.homedir(), 'AppData', 'LocalLow', 'MCC', 'Temporary');
    const localPath = path.join(process.cwd(), 'Maps_to_Rename');

    // Priorizar carpeta local para testing
    if (fs.existsSync(localPath)) {
        console.log('📁 Usando carpeta local Maps_to_Rename para testing');
        return localPath;
    }

    if (process.platform === 'win32') {
        if (!fs.existsSync(windowsPath)) {
            try {
                fs.mkdirSync(windowsPath, { recursive: true });
            } catch (e) {
                console.log(`⚠️  No se pudo crear carpeta MCC: ${e.message}`);
            }
        }
        if (fs.existsSync(windowsPath)) {
            console.log(`📁 Monitoreando carpeta MCC: ${windowsPath}`);
            return windowsPath;
        }
    }

    // Fallback
    if (!fs.existsSync(localPath)) {
        fs.mkdirSync(localPath, { recursive: true });
    }
    console.log(`📁 Monitoreando carpeta: ${localPath}`);
    return localPath;
}

function parseTimestamp(filename) {
    const match = filename.match(/(\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2})/);
    if (match) {
        const parts = match[1].split('-');
        return new Date(
            parseInt(parts[0]),
            parseInt(parts[1]) - 1,
            parseInt(parts[2]),
            parseInt(parts[3]),
            parseInt(parts[4]),
            parseInt(parts[5])
        );
    }
    return new Date();
}

function parseXML(filePath) {
    const xmlContent = fs.readFileSync(filePath, 'utf-8');
    const parser = new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: ''
    });
    const result = parser.parse(xmlContent);
    const root = result.CarnageReport || result.MultiplayerCarnageReport || result;

    const hopperName = root.HopperName?.HopperName || 'Unknown';
    const mapNameFromXML = root.MapName?.MapName || root.MapName;

    const gameData = {
        gameUniqueId: root.GameUniqueId?.GameUniqueId || 'unknown',
        gameEnum: parseInt(root.GameEnum?.mGameEnum || 0),
        isMatchmaking: root.IsMatchmaking?.IsMatchmaking === 'true',
        isTeamsEnabled: root.IsTeamsEnabled?.IsTeamsEnabled === 'true',
        hopperName: hopperName,
        gameTypeName: root.GameTypeName?.GameTypeName || 'Slayer',
        timestamp: parseTimestamp(path.basename(filePath)),
    };

    // Prioridad: 1. Mapping por nombre archivo, 2. Tag MapName del XML, 3. HopperName, 4. Fallback
    const mapFromName = getMapName(path.basename(filePath), gameData);
    if (mapFromName !== 'Halo 3 Match' && mapFromName !== 'Halo 3 Map') {
        gameData.mapName = mapFromName;
    } else if (mapNameFromXML && mapNameFromXML !== 'Unknown' && mapNameFromXML !== '') {
        gameData.mapName = mapNameFromXML;
    } else {
        gameData.mapName = mapFromName;
    }

    const playersNode = root.Players?.Player;
    const players = (Array.isArray(playersNode) ? playersNode : [playersNode]).filter(Boolean).map(p => ({
        xboxUserId: p.mXboxUserId || '',
        gamertag: p.mGamertagText || 'Unknown',
        clanTag: p.ClantagText || '',
        serviceId: p.ServiceId || '',
        teamId: parseInt(p.mTeamId || 0),
        score: parseInt(p.Score || 0),
        standing: parseInt(p.mStanding || 0),
        kills: parseInt(p.mKills || 0),
        deaths: parseInt(p.mDeaths || 0),
        assists: parseInt(p.mAssists || 0),
        betrayals: parseInt(p.mBetrayals || 0),
        suicides: parseInt(p.mSuicides || 0),
        mostKillsInARow: parseInt(p.mMostKillsInARow || 0)
    }));

    return { gameData, players };
}

// ============== ENVÍO AL SERVIDOR ==============

async function sendToServer(gameData, players, filename) {
    const payload = JSON.stringify({ gameData, players, filename });
    const url = new URL(`${CONFIG.serverUrl}/api/report`);
    const isHttps = url.protocol === 'https:';
    const httpModule = isHttps ? https : http;

    const options = {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
            'X-API-Key': CONFIG.apiKey
        }
    };

    return new Promise((resolve, reject) => {
        const req = httpModule.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const response = JSON.parse(data);
                    resolve(response);
                } catch (e) {
                    resolve({ status: 'error', message: data });
                }
            });
        });

        req.on('error', (e) => {
            reject(new Error(`Error de conexión: ${e.message}`));
        });

        req.setTimeout(30000, () => {
            req.destroy();
            reject(new Error('Timeout: El servidor no respondió'));
        });

        req.write(payload);
        req.end();
    });
}

// ============== PROCESAMIENTO ==============

const processedFiles = new Set();

async function processXMLFile(filePath) {
    const filename = path.basename(filePath);

    // Filtros
    if (processedFiles.has(filename)) return;
    if (!filename.includes('mpcarnagereport') && !filename.includes('asq_')) return;
    if (filename.includes('test_trigger')) return;

    console.log(`\n🎮 Procesando: ${filename}`);
    processedFiles.add(filename);

    try {
        // 1. Parsear XML
        const { gameData, players } = parseXML(filePath);
        console.log(`   Mapa: ${gameData.mapName}, Jugadores: ${players.length}`);

        // 2. Enviar al servidor
        console.log(`   📤 Enviando al servidor...`);
        const response = await sendToServer(gameData, players, filename);

        if (response.status === 'processed') {
            console.log(`   ✅ Procesado: ${response.message}`);
        } else if (response.status === 'duplicate') {
            console.log(`   ⏭️  Duplicado: ${response.message}`);
        } else {
            console.log(`   ⚠️  Respuesta: ${response.message || response.error}`);
        }

        // 3. Eliminar XML original
        try {
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
                console.log(`   🗑️  XML eliminado`);
            }
            // Permitir que el mismo nombre de archivo sea detectado de nuevo tras un breve delay
            // Esto es crucial para archivos con nombres genéricos que se sobreescriben
            setTimeout(() => processedFiles.delete(filename), 5000);
        } catch (e) {
            console.log(`   ⚠️  No se pudo eliminar el XML: ${e.message}`);
            setTimeout(() => processedFiles.delete(filename), 10000);
        }

    } catch (error) {
        console.error(`   ❌ Error: ${error.message}`);

        // Reintentar en 5 segundos si es error de conexión
        if (error.message.includes('conexión') || error.message.includes('Timeout')) {
            console.log(`   🔄 Reintentando en 5 segundos...`);
            processedFiles.delete(filename);
            setTimeout(() => processXMLFile(filePath), 5000);
        }
    }
}

// ============== MAIN ==============

async function main() {
    console.log('╔══════════════════════════════════════════════════════════╗');
    console.log('║              CARNAGE REPORTER CLIENT                     ║');
    console.log('║            Halo 3 MCC Stats Tracker v1.0                 ║');
    console.log('╚══════════════════════════════════════════════════════════╝\n');

    console.log(`🌐 Servidor: ${CONFIG.serverUrl}`);

    // Verificar conexión con el servidor
    console.log('🔌 Verificando conexión con el servidor...');
    try {
        const url = new URL(`${CONFIG.serverUrl}/api/health`);
        const isHttps = url.protocol === 'https:';
        const httpModule = isHttps ? https : http;

        await new Promise((resolve, reject) => {
            const req = httpModule.get(url.href, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const response = JSON.parse(data);
                        console.log(`✅ Servidor conectado`);
                        resolve();
                    } catch (e) {
                        reject(new Error('Respuesta inválida del servidor'));
                    }
                });
            });
            req.on('error', reject);
            req.setTimeout(10000, () => {
                req.destroy();
                reject(new Error('Timeout'));
            });
        });
    } catch (error) {
        console.log(`⚠️  No se pudo conectar al servidor: ${error.message}`);
        console.log('   El cliente continuará intentando enviar reportes...\n');
    }

    // Obtener directorio de monitoreo
    const watchDir = getMCCTempPath();

    // Iniciar monitoreo
    console.log('\n👀 Monitoreando nuevas partidas...');
    console.log('   (Juega una partida de Halo 3 y los stats serán enviados al servidor)\n');

    const watcher = chokidar.watch(path.join(watchDir, '*.xml'), {
        persistent: true,
        ignoreInitial: true,
        usePolling: true,      // Monitoreo activo (más robusto en Windows/Red)
        interval: 2000,        // Intervalo de escaneo (2 segundos)
        binaryInterval: 3000,
        awaitWriteFinish: {    // Asegurar que el archivo terminó de escribirse
            stabilityThreshold: 1500,
            pollInterval: 100
        }
    });

    // Escuchar tanto 'add' como 'change' para detectar archivos renombrados
    watcher.on('add', (filePath) => {
        processXMLFile(filePath);
    });

    watcher.on('change', (filePath) => {
        // También procesar cambios (cubre casos de rename atómico)
        processXMLFile(filePath);
    });

    watcher.on('error', (error) => {
        console.error('❌ Error en el monitor:', error);
    });

    // Cierre graceful
    process.on('SIGINT', () => {
        console.log('\n\n👋 Cerrando cliente...');
        watcher.close();
        process.exit(0);
    });
}

main().catch(console.error);
