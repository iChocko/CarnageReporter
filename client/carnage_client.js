const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');
const { XMLParser } = require('fast-xml-parser');
const chokidar = require('chokidar');
const axios = require('axios');
const { spawn } = require('child_process');

// ============== CONFIGURACIÓN (Lanzamiento Oficial) ==============

const VERSION = '1.2.0';
const GITHUB_REPO = 'iChocko/CarnageReporter';
const EXE_NAME = 'CarnageReporter.exe';
const DISCORD_URL = 'https://discord.gg/yD6nGZ3KQX';

const CONFIG = {
    serverUrl: 'https://h3mccstats.cloud',
    apiKey: null, // Se resuelve en resolveConfig(): build (config.gen.js) > config.json > env

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

// ============== RESOLUCIÓN DE CONFIGURACIÓN ==============
// Prioridad (de menor a mayor): config.gen.js (build) < config.json (junto al exe) < variables de entorno

function resolveConfig() {
    // 1. config.gen.js: generado por el CI al compilar el .exe (no existe en el repo)
    try {
        const gen = require('./config.gen.js');
        if (gen.apiKey) CONFIG.apiKey = gen.apiKey;
        if (gen.serverUrl) CONFIG.serverUrl = gen.serverUrl;
    } catch (e) { }

    // 2. config.json junto al ejecutable (o al cwd en modo desarrollo):
    //    permite rotar la key o apuntar a otro servidor sin recompilar
    const candidates = [
        path.join(path.dirname(process.execPath), 'config.json'),
        path.join(process.cwd(), 'config.json')
    ];
    for (const cfgPath of candidates) {
        try {
            if (fs.existsSync(cfgPath)) {
                const userCfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
                if (userCfg.apiKey) CONFIG.apiKey = userCfg.apiKey;
                if (userCfg.serverUrl) CONFIG.serverUrl = userCfg.serverUrl;
                console.log(`⚙️  Configuración cargada desde: ${cfgPath}`);
                break;
            }
        } catch (e) {
            console.log(`⚠️  config.json inválido (${cfgPath}): ${e.message}`);
        }
    }

    // 3. Variables de entorno (útil para pruebas locales)
    if (process.env.CARNAGE_API_KEY) CONFIG.apiKey = process.env.CARNAGE_API_KEY;
    if (process.env.CARNAGE_SERVER_URL) CONFIG.serverUrl = process.env.CARNAGE_SERVER_URL;

    if (!CONFIG.apiKey) {
        console.error('\n❌ No hay API key configurada.');
        console.error('   Descarga el ejecutable oficial desde GitHub Releases, o crea un');
        console.error('   archivo config.json junto al programa con este contenido:');
        console.error('   { "apiKey": "TU_API_KEY", "serverUrl": "https://h3mccstats.cloud" }');
        return false;
    }
    return true;
}

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
        // v2: flags de completitud de la partida
        lastMatchIncomplete: root.mLastMatchIncomplete?.mLastMatchIncomplete === 'true',
        partySize: parseInt(root.mPartySize?.mPartySize || 0),
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
    const players = (Array.isArray(playersNode) ? playersNode : [playersNode]).filter(Boolean).map(p => {
        // v2: medallas — solo las que tienen conteo > 0 (de 384 posibles quedan pocas)
        const medalsNode = p.MedalsCount?.Medal;
        const medals = (Array.isArray(medalsNode) ? medalsNode : [medalsNode])
            .filter(Boolean)
            .map(m => ({ id: parseInt(m.mId || 0), count: parseInt(m.mCount || 0) }))
            .filter(m => m.count > 0);

        return {
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
            mostKillsInARow: parseInt(p.mMostKillsInARow || 0),
            // v2: duración y completitud por jugador
            secondsPlayed: parseInt(p.mSecondsPlayed || 0),
            secondsAlive: parseInt(p.mSecondsAlive || 0),
            completedGame: p.mCompletedGame !== undefined ? parseInt(p.mCompletedGame) : null,
            // v2: desglose de kills por tipo
            killsWeapon: parseInt(p.mKillsWeapon || 0),
            killsGrenade: parseInt(p.mKillsGrenade || 0),
            killsMelee: parseInt(p.mKillsMelee || 0),
            killsOther: parseInt(p.mKillsOther || 0),
            isGuest: p.isGuest === 'true',
            medals: medals
        };
    });

    // v2: duración de la partida = el mayor tiempo jugado entre los presentes
    gameData.duration = players.reduce((max, p) => Math.max(max, p.secondsPlayed || 0), 0);

    return { gameData, players };
}

// ============== ENVÍO AL SERVIDOR ==============

async function sendToServer(gameData, players, filename) {
    const payload = JSON.stringify({
        schemaVersion: 2,
        clientVersion: VERSION,
        gameData,
        players,
        filename
    });
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
        } else if (response.status === 'voided') {
            console.log(`   🚫 Partida anulada (${response.reason}): no cuenta para stats.`);
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

// ============== SISTEMA DE AUTO-ACTUALIZACIÓN ==============

// Comparación simple de versiones semver (major.minor.patch)
function isNewerVersion(latest, current) {
    const latestParts = latest.replace('v', '').split('.').map(Number);
    const currentParts = current.replace('v', '').split('.').map(Number);

    for (let i = 0; i < 3; i++) {
        const l = latestParts[i] || 0;
        const c = currentParts[i] || 0;
        if (l > c) return true;
        if (l < c) return false;
    }
    return false;
}

async function checkForUpdates() {
    if (process.env.SKIP_UPDATE) return;

    try {
        console.log('🔍 Buscando actualizaciones...');
        const res = await axios.get(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
            timeout: 8000,
            headers: {
                'User-Agent': `CarnageReporter/${VERSION}`,
                'Accept': 'application/vnd.github.v3+json'
            }
        });

        const latestVersion = res.data.tag_name;
        const currentVersion = VERSION;

        if (isNewerVersion(latestVersion, currentVersion)) {
            console.log(`\n✨ ¡Nueva versión disponible: ${latestVersion}! (Actual: v${currentVersion})`);

            // Buscar el asset .exe
            const asset = res.data.assets.find(a => a.name.toLowerCase().endsWith('.exe'));
            if (!asset) {
                console.log('⚠️  No se encontró el archivo ejecutable en el release.');
                return;
            }

            console.log('📥 Descargando actualización...');
            const downloadRes = await axios.get(asset.browser_download_url, {
                responseType: 'arraybuffer',
                timeout: 60000, // 1 minuto para descargas grandes
                headers: {
                    'User-Agent': `CarnageReporter/${VERSION}`
                }
            });

            const tempExe = path.join(process.cwd(), 'update_temp.exe');
            fs.writeFileSync(tempExe, downloadRes.data);

            console.log('✅ Descarga completa. Reiniciando para aplicar cambios...');

            // Crear script de reemplazo (.bat para Windows)
            const currentExe = process.execPath;
            const exeName = path.basename(currentExe);
            const batPath = path.join(process.cwd(), 'updater.bat');

            // Usar rutas absolutas y escapar correctamente
            const batContent = `@echo off
echo Aplicando actualizacion...
timeout /t 2 /nobreak > nul
del /f /q "${currentExe}"
if exist "${currentExe}" (
    timeout /t 2 /nobreak > nul
    del /f /q "${currentExe}"
)
move /y "${tempExe}" "${currentExe}"
start "" "${currentExe}"
del /f /q "%~f0"
`;

            fs.writeFileSync(batPath, batContent);

            // Lanzar el bat y cerrar la app
            spawn('cmd.exe', ['/c', batPath], {
                detached: true,
                stdio: 'ignore',
                cwd: process.cwd()
            }).unref();

            process.exit(0);
        } else {
            console.log('✅ Estás usando la versión más reciente.');
        }
    } catch (error) {
        // No bloquear el inicio si falla la verificación
        if (error.response && error.response.status === 404) {
            console.log('⚠️  No hay releases publicados aún.');
        } else {
            console.log('⚠️  No se pudo verificar actualizaciones.');
        }
    }
}

// ============== MAIN ==============

async function main() {
    console.clear();
    console.log('╔══════════════════════════════════════════════════════════╗');
    console.log('║               CARNAGE REPORTER - HALO 3                  ║');
    console.log(`║                 Registro de Estadísticas v${VERSION}        ║`);
    console.log('╚══════════════════════════════════════════════════════════╝\n');

    // Resolver configuración (API key y servidor)
    if (!resolveConfig()) {
        console.log('\nPresiona Ctrl+C para salir.');
        return;
    }

    // Revisar actualizaciones al iniciar
    await checkForUpdates();

    console.log(`\nServidor: ${CONFIG.serverUrl.replace(/^https?:\/\//, '')}`);

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
    console.log(`\n🎮 Discord: ${DISCORD_URL}`);

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

if (require.main === module) {
    main().catch(console.error);
} else {
    module.exports = { parseXML, resolveConfig, CONFIG, VERSION };
}
