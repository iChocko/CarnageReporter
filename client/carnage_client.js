const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');
const { XMLParser } = require('fast-xml-parser');
const chokidar = require('chokidar');

// ============== CONFIGURACIÓN (Lanzamiento Oficial) ==============

const CONFIG = {
    // Valores de producción integrados directamente
    serverUrl: 'https://h3mccstats.cloud',
    apiKey: 'h3mcc-carnage-2024-secret',

    // Mapeo de nombres de mapas (Halo 3 Legacy)
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

    if (fs.existsSync(localPath)) {
        return localPath;
    }

    if (process.platform === 'win32') {
        if (!fs.existsSync(windowsPath)) {
            try {
                fs.mkdirSync(windowsPath, { recursive: true });
            } catch (e) { }
        }
        if (fs.existsSync(windowsPath)) {
            return windowsPath;
        }
    }

    if (!fs.existsSync(localPath)) {
        fs.mkdirSync(localPath, { recursive: true });
    }
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
            reject(new Error(`Sin conexión con el servidor`));
        });

        req.setTimeout(30000, () => {
            req.destroy();
            reject(new Error('El servidor no responde (Timeout)'));
        });

        req.write(payload);
        req.end();
    });
}

// ============== PROCESAMIENTO ==============

const processedFiles = new Set();

async function processXMLFile(filePath) {
    const filename = path.basename(filePath);

    if (processedFiles.has(filename)) return;
    if (!filename.includes('mpcarnagereport') && !filename.includes('asq_')) return;
    if (filename.includes('test_trigger')) return;

    console.log(`\n📦 Nueva partida registrada: ${filename}`);
    processedFiles.add(filename);

    try {
        const { gameData, players } = parseXML(filePath);
        console.log(`   🔸 Mapa: ${gameData.mapName} | Jugadores: ${players.length}`);

        console.log(`   🔹 Enviando estadísticas al servidor...`);
        const response = await sendToServer(gameData, players, filename);

        if (response.status === 'processed') {
            console.log(`   ✅ Datos guardados correctamente.`);
        } else if (response.status === 'duplicate') {
            console.log(`   ⏭️  Esta partida ya estaba en el sistema.`);
        } else {
            console.log(`   ⚠️  Servidor: ${response.message || response.error}`);
        }

        try {
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }
            setTimeout(() => processedFiles.delete(filename), 5000);
        } catch (e) {
            setTimeout(() => processedFiles.delete(filename), 10000);
        }

    } catch (error) {
        console.error(`   ❌ Error: ${error.message}`);
        if (error.message.includes('conexión') || error.message.includes('Timeout')) {
            console.log(`   🔄 Reintentando envío...`);
            processedFiles.delete(filename);
            setTimeout(() => processXMLFile(filePath), 5000);
        }
    }
}

// ============== MAIN ==============

async function main() {
    console.clear();
    console.log('╔══════════════════════════════════════════════════════════╗');
    console.log('║               CARNAGE REPORTER - HALO 3                  ║');
    console.log('║                 Registro de Estadísticas                 ║');
    console.log('╚══════════════════════════════════════════════════════════╝\n');

    console.log('Servidor: h3mccstats.cloud');

    // Verificar conexión
    try {
        const url = new URL(`${CONFIG.serverUrl}/api/health`);
        const isHttps = url.protocol === 'https:';
        const httpModule = isHttps ? https : http;

        await new Promise((resolve, reject) => {
            const req = httpModule.get(url.href, (res) => {
                res.on('data', () => { });
                res.on('end', () => resolve());
            });
            req.on('error', reject);
            req.setTimeout(5000, () => { req.destroy(); reject(); });
        });
        console.log('✅ Conexión con el servidor establecida.');
    } catch (error) {
        console.log('⚠️  Servidor fuera de línea. Se intentará reconectar al jugar.');
    }

    const watchDir = getMCCTempPath();
    console.log('\n📡 REGISTRO ACTIVO');
    console.log('   No cierres esta ventana mientras juegas para guardar tus stats.');

    const watcher = chokidar.watch(path.join(watchDir, '*.xml'), {
        persistent: true,
        ignoreInitial: true,
        usePolling: true,
        interval: 2000,
        awaitWriteFinish: {
            stabilityThreshold: 1500,
            pollInterval: 100
        }
    });

    watcher.on('add', (filePath) => processXMLFile(filePath));
    watcher.on('change', (filePath) => processXMLFile(filePath));
    watcher.on('error', (error) => console.error('❌ Error en el sistema de monitoreo:', error));

    process.on('SIGINT', () => {
        console.log('\n\n👋 Cerrando programa. Hasta la próxima.');
        watcher.close();
        process.exit(0);
    });
}

main().catch(console.error);
