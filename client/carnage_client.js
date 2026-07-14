const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');
const { XMLParser } = require('fast-xml-parser');
const chokidar = require('chokidar');
const axios = require('axios');
const { spawn, spawnSync } = require('child_process');
const readline = require('readline');

// ============== CONFIGURACIÓN (Lanzamiento Oficial) ==============

const VERSION = '1.6.0';
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
        'asq_warehou': 'Amplified',
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

// ============== RUTAS BASE Y MODO (v1.6.0) ==============
// Empaquetado con pkg, TODO lo que el programa escribe (settings, log,
// updates) vive JUNTO AL EXE, nunca en el cwd: cuando Windows nos arranca
// solo (clave Run), el cwd es System32 y ahí no se puede escribir.

const IS_PKG = typeof process.pkg !== 'undefined';
const BASE_DIR = IS_PKG ? path.dirname(process.execPath) : __dirname;
const IS_BACKGROUND = process.argv.includes('--background');

const SETTINGS_FILE = path.join(BASE_DIR, 'settings.json');
const LOG_FILE = path.join(BASE_DIR, 'carnage_client.log');
const VBS_FILE = path.join(BASE_DIR, 'carnage_autostart.vbs');
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const RUN_VALUE = 'CarnageReporter';
const STATUS_PORT = 47613; // candado de instancia única + estado local

// ============== PREFERENCIAS (settings.json junto al exe) ==============

function loadSettings(file = SETTINGS_FILE) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch (e) {
        return {};
    }
}

function saveSettings(patch, file = SETTINGS_FILE) {
    const merged = { ...loadSettings(file), ...patch };
    try {
        fs.writeFileSync(file, JSON.stringify(merged, null, 2));
    } catch (e) { }
    return merged;
}

// ============== LOG A ARCHIVO (modo segundo plano) ==============
// Invisible no significa mudo: todo lo que normalmente iría a la consola
// queda en carnage_client.log junto al exe, con rotación simple a 1 MB.

const LOG_MAX_BYTES = 1024 * 1024;

function setupFileLogging() {
    const emit = (prefix, args) => {
        const text = args
            .map(a => (a instanceof Error ? (a.stack || a.message) : (typeof a === 'string' ? a : JSON.stringify(a))))
            .join(' ');
        try {
            if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > LOG_MAX_BYTES) {
                const old = path.join(BASE_DIR, 'carnage_client.old.log');
                try { fs.unlinkSync(old); } catch (e) { }
                fs.renameSync(LOG_FILE, old);
            }
            fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}]${prefix} ${text}\n`);
        } catch (e) { }
    };
    console.log = (...args) => emit('', args);
    console.error = (...args) => emit(' [ERROR]', args);
    console.clear = () => { };
}

// ============== INSTANCIA ÚNICA Y ESTADO LOCAL ==============
// Un mini-servidor HTTP SOLO en 127.0.0.1 hace doble trabajo: si el puerto
// está ocupado ya hay otra instancia (evita partidas reportadas doble), y
// además le da a la apertura manual una forma de consultar el estado de la
// instancia de fondo o pedirle que se apague.

const STATS = { startedAt: Date.now(), reportsSent: 0, lastReportAt: null };

function startStatusServer(mode) {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            if (req.method === 'POST' && req.url === '/shutdown') {
                res.end('bye');
                console.log('🛑 Apagado solicitado desde otra instancia local.');
                setTimeout(() => process.exit(0), 200);
                return;
            }
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({
                app: 'CarnageReporter', version: VERSION, mode,
                startedAt: STATS.startedAt, reportsSent: STATS.reportsSent, lastReportAt: STATS.lastReportAt
            }));
        });
        server.on('error', () => resolve(null)); // puerto ocupado: ya hay otra instancia
        server.listen(STATUS_PORT, '127.0.0.1', () => resolve(server));
    });
}

function queryRunningInstance() {
    return new Promise((resolve) => {
        const req = http.get({ host: '127.0.0.1', port: STATUS_PORT, path: '/', timeout: 1500 }, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { resolve(null); } });
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
    });
}

function shutdownRunningInstance() {
    return new Promise((resolve) => {
        const req = http.request(
            { host: '127.0.0.1', port: STATUS_PORT, path: '/shutdown', method: 'POST', timeout: 1500 },
            (res) => { res.on('data', () => { }); res.on('end', () => resolve(true)); }
        );
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
        req.end();
    });
}

// ============== ARRANQUE AUTOMÁTICO CON WINDOWS ==============
// La clave Run de HKCU (no pide admin) apunta a wscript + un .vbs de una
// línea que lanza el exe SIN ventana. Apuntar la clave directo al exe
// mostraría un consolazo negro en cada arranque de Windows.

function buildVbsContent(exePath, scriptPath = null) {
    // En desarrollo el "exe" es node y hay que pasarle el script; empaquetado
    // con pkg el exe se basta solo. Las comillas dobles ("") escapan en VBS.
    const cmd = scriptPath
        ? `""${exePath}"" ""${scriptPath}"" --background`
        : `""${exePath}"" --background`;
    return `CreateObject("WScript.Shell").Run "${cmd}", 0, False\r\n`;
}

function enableAutostart() {
    if (process.platform !== 'win32') return false;
    try {
        fs.writeFileSync(VBS_FILE, buildVbsContent(process.execPath, IS_PKG ? null : __filename));
    } catch (e) {
        return false;
    }
    const r = spawnSync('reg', [
        'add', RUN_KEY, '/v', RUN_VALUE, '/t', 'REG_SZ',
        '/d', `wscript.exe "${VBS_FILE}"`, '/f'
    ], { windowsHide: true });
    return r.status === 0;
}

function disableAutostart() {
    if (process.platform !== 'win32') return false;
    const r = spawnSync('reg', ['delete', RUN_KEY, '/v', RUN_VALUE, '/f'], { windowsHide: true });
    try { fs.unlinkSync(VBS_FILE); } catch (e) { }
    return r.status === 0;
}

function launchBackgroundInstance() {
    // Con pkg, execPath ES el exe; en desarrollo es node y hay que pasar el script
    const args = IS_PKG ? ['--background'] : [__filename, '--background'];
    spawn(process.execPath, args, { detached: true, stdio: 'ignore', windowsHide: true, cwd: BASE_DIR }).unref();
}

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

    // Ignorar tokens de localización sin resolver (ej. "$MP_H3TeamDoubles_Title")
    if (gameData.hopperName && gameData.hopperName !== 'Unknown' && gameData.hopperName !== ''
        && !gameData.hopperName.startsWith('$')) {
        return gameData.hopperName;
    }

    if (fn.includes('mpcarnagereport')) return 'Halo 3 Match';
    return 'Halo 3 Map';
}

// El XML de carnage report NO trae el mapa (ni en su contenido ni en el nombre
// de archivo: llega como "mpcarnagereport*.xml"). La única fuente por partida
// es el film que MCC autoguarda durante el juego en Halo3/autosave/, cuyo
// nombre SÍ lleva el código del mapa: "asq_warehou_2B3D71C8_6A5319E9.film".
// Los sufijos son grupos de 8 hex (hash/id) que hay que quitar.
const FILM_MAX_AGE_MS = 30 * 60 * 1000; // un film más viejo no es de esta partida

function extractMapCodeFromFilmName(name) {
    const base = name.toLowerCase()
        .replace(/\.(film|temp)$/, '')
        .replace(/(_[0-9a-f]{8})+$/, '');
    return /^asq_[a-z0-9_]+$/.test(base) ? base : null;
}

function findMapCodeFromFilms(xmlDir) {
    try {
        const autosaveDir = path.join(xmlDir, 'Halo3', 'autosave');
        const candidates = fs.readdirSync(autosaveDir)
            .filter(f => /^asq_.*\.(film|temp)$/i.test(f))
            .map(f => ({ name: f, mtime: fs.statSync(path.join(autosaveDir, f)).mtimeMs }))
            .sort((a, b) => b.mtime - a.mtime);

        if (candidates.length === 0) return null;
        if (Date.now() - candidates[0].mtime > FILM_MAX_AGE_MS) return null;
        return extractMapCodeFromFilmName(candidates[0].name);
    } catch (e) {
        return null;
    }
}

function getMCCTempPath() {
    const windowsPath = path.join(os.homedir(), 'AppData', 'LocalLow', 'MCC', 'Temporary');
    // Junto al exe cuando está empaquetado: arrancados por Windows el cwd es System32
    const localPath = path.join(IS_PKG ? BASE_DIR : process.cwd(), 'Maps_to_Rename');

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

    // v1.5.0: mandar el CÓDIGO crudo del mapa. El nombre del XML nunca lo trae
    // (siempre es "mpcarnagereport*"), así que la fuente real es el film de
    // autosave más reciente. El servidor lo traduce a nombre bonito y recopila
    // los códigos desconocidos. Sin film reciente -> null.
    const codeMatch = path.basename(filePath).toLowerCase().match(/asq_[a-z0-9_]+/);
    gameData.mapCode = (codeMatch ? codeMatch[0] : null)
        || findMapCodeFromFilms(path.dirname(filePath));
    if (gameData.mapCode && CONFIG.maps[gameData.mapCode]) {
        gameData.mapName = CONFIG.maps[gameData.mapCode];
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
            STATS.reportsSent++;
            STATS.lastReportAt = Date.now();
            console.log(`   ✅ Datos guardados correctamente.`);
        } else if (response.status === 'duplicate') {
            console.log(`   ⏭️  Esta partida ya estaba en el sistema.`);
        } else if (response.status === 'voided') {
            console.log(`   🚫 Partida anulada (${response.reason}): no cuenta para stats.`);
        } else if (response.status === 'skipped') {
            console.log(`   ⏭️  Partida de matchmaking ignorada (solo se registran customs 2v2).`);
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

            // Siempre junto al exe: en modo automático el cwd es System32
            const tempExe = path.join(BASE_DIR, 'update_temp.exe');
            fs.writeFileSync(tempExe, downloadRes.data);

            console.log('✅ Descarga completa. Reiniciando para aplicar cambios...');

            // Crear script de reemplazo (.bat para Windows)
            const currentExe = process.execPath;
            const batPath = path.join(BASE_DIR, 'updater.bat');

            // En segundo plano el relanzamiento debe ser invisible (via el
            // .vbs de autoarranque); en manual se reabre la consola normal.
            let relaunch = `start "" "${currentExe}"`;
            if (IS_BACKGROUND) {
                try { fs.writeFileSync(VBS_FILE, buildVbsContent(currentExe)); } catch (e) { }
                relaunch = `start "" wscript.exe "${VBS_FILE}"`;
            }

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
${relaunch}
del /f /q "%~f0"
`;

            fs.writeFileSync(batPath, batContent);

            // Lanzar el bat y cerrar la app
            spawn('cmd.exe', ['/c', batPath], {
                detached: true,
                stdio: 'ignore',
                windowsHide: IS_BACKGROUND,
                cwd: BASE_DIR
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

// ============== PIEZAS COMPARTIDAS DE ARRANQUE ==============

async function verifyServerConnection() {
    console.log(`\nServidor: ${CONFIG.serverUrl.replace(/^https?:\/\//, '')}`);
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
}

function startWatcher() {
    const watchDir = getMCCTempPath();
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
    return watcher;
}

// ============== MODO SEGUNDO PLANO (--background) ==============
// Sin ventana, sin prompts: Windows nos arranca vía la clave Run + el .vbs.
// Todo va a la bitácora, y el estado se consulta abriendo el exe a mano.

async function runBackground() {
    setupFileLogging();
    console.log(`🚀 CarnageReporter v${VERSION} arrancando en segundo plano (${BASE_DIR})`);
    // Invisible no puede tronar en silencio Y morir: se registra y se sigue
    process.on('uncaughtException', (e) => console.error('Error no capturado:', e));
    process.on('unhandledRejection', (e) => console.error('Promesa rechazada:', e));

    if (!resolveConfig()) {
        console.error('Sin API key configurada; no puedo registrar partidas. Saliendo.');
        process.exit(1);
    }

    const server = await startStatusServer('background');
    if (!server) {
        console.log('Ya hay otra instancia corriendo; me retiro para no duplicar reportes.');
        process.exit(0);
    }

    // Nadie va a volver a abrir el exe a mano: las actualizaciones llegan
    // solas — al arrancar la compu y luego una revisión diaria silenciosa.
    await checkForUpdates();
    setInterval(() => checkForUpdates().catch(() => { }), 24 * 60 * 60 * 1000);

    await verifyServerConnection();
    startWatcher();
    console.log('📡 Registro activo (modo automático). Vigilando la carpeta de MCC.');
}

// ============== MODO INTERACTIVO (doble clic de siempre) ==============

function ask(question) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => rl.question(question, answer => { rl.close(); resolve(answer.trim()); }));
}

async function askYesNo(question) {
    for (; ;) {
        const a = (await ask(question)).toLowerCase();
        if (['s', 'si', 'sí', 'y'].includes(a)) return true;
        if (['n', 'no'].includes(a)) return false;
        console.log('   Responde S o N, porfa.');
    }
}

function fmtAgo(ts) {
    if (!ts) return 'ninguna todavía';
    const min = Math.round((Date.now() - ts) / 60000);
    if (min < 1) return 'hace un momento';
    if (min < 60) return `hace ${min} min`;
    const h = Math.round(min / 60);
    return h < 24 ? `hace ${h} h` : `hace ${Math.round(h / 24)} días`;
}

/**
 * Activa el modo automático: registra el arranque con Windows, lanza la
 * instancia invisible y programa el cierre de esta ventana. beforeLaunch
 * permite soltar recursos (watcher/puerto) antes de lanzar el fondo.
 */
async function activateAutomaticMode(beforeLaunch = null) {
    if (!enableAutostart()) {
        console.log('\n⚠️  No pude registrar el arranque automático en Windows. Seguimos en modo manual.');
        return false;
    }
    saveSettings({ autostart: 'on' });
    if (beforeLaunch) await beforeLaunch();
    launchBackgroundInstance();
    console.log('\n✅ ¡Listo! El modo automático quedó activado.');
    console.log('   Desde ahora me prendo solo cuando prendas tu compu y tus retas');
    console.log('   se suben solitas. Esta ventana se cierra en 15 segundos.');
    setTimeout(() => process.exit(0), 15000);
    return true;
}

async function promptActivation() {
    console.log('╔══════════════════════════════════════════════════╗');
    console.log('║              ¡NUEVO! MODO AUTOMÁTICO             ║');
    console.log('╚══════════════════════════════════════════════════╝\n');
    console.log('¿Quieres que el registro de partidas se encienda');
    console.log('solo cada vez que prendas tu compu?\n');
    console.log('Así ya no tienes que abrir nada: tus retas se');
    console.log('suben solitas al bot.\n');
    return askYesNo('Escribe S para activar, N para seguir como antes: ');
}

async function interactiveMenu(inst) {
    console.log(`✅ El modo automático está ACTIVO en segundo plano (v${inst.version}).`);
    console.log(`   Corriendo desde: ${new Date(inst.startedAt).toLocaleString()}`);
    console.log(`   Partidas enviadas: ${inst.reportsSent} · Última: ${fmtAgo(inst.lastReportAt)}`);
    console.log(`   Bitácora: ${LOG_FILE}\n`);

    for (; ;) {
        console.log('¿Qué quieres hacer?');
        console.log('  [1] Actualizar estado');
        console.log('  [2] Desactivar el modo automático');
        console.log('  [3] Salir');
        const opt = await ask('Opción: ');

        if (opt === '1') {
            const fresh = await queryRunningInstance();
            if (!fresh) {
                console.log('\n⚠️  La instancia de fondo ya no responde.\n');
                continue;
            }
            console.log(`\n   v${fresh.version} · corriendo desde ${new Date(fresh.startedAt).toLocaleString()}`);
            console.log(`   Partidas enviadas: ${fresh.reportsSent} · Última: ${fmtAgo(fresh.lastReportAt)}\n`);
        } else if (opt === '2') {
            const sure = await askYesNo('\n¿Seguro? Ya no me prenderé solo y tendrás que abrirme a mano para registrar tus partidas (S/N): ');
            if (!sure) { console.log(''); continue; }
            disableAutostart();
            saveSettings({ autostart: 'no' });
            await shutdownRunningInstance();
            console.log('\n👋 Listo: modo automático desactivado y registro de fondo detenido.');
            const manual = await askYesNo('¿Dejo esta ventana registrando en modo manual mientras tanto? (S/N): ');
            if (manual) return runManualWatch(loadSettings());
            console.log('\nHasta la próxima. Puedes cerrar esta ventana.');
            return;
        } else if (opt === '3') {
            console.log('\nTodo sigue corriendo en el fondo. Puedes cerrar esta ventana.');
            return;
        } else {
            console.log('   Opción no válida.\n');
        }
    }
}

async function runManualWatch(settings) {
    await verifyServerConnection();

    const statusServer = await startStatusServer('manual');
    const watcher = startWatcher();

    console.log('\n📡 REGISTRO ACTIVO');
    console.log('   No cierres esta ventana mientras juegas para guardar tus stats.');
    if (settings.autostart === 'no') {
        console.log('\n💡 ¿Cansado de abrirme a mano? Escribe A y Enter para activar el modo automático.');
        const rl = readline.createInterface({ input: process.stdin });
        rl.on('line', async (line) => {
            if (line.trim().toLowerCase() !== 'a') return;
            console.log('\n⚙️  Activando el modo automático...');
            await activateAutomaticMode(async () => {
                rl.close();
                await watcher.close();
                if (statusServer) statusServer.close();
            });
        });
    }
    console.log(`\n🎮 Discord: ${DISCORD_URL}`);
}

async function runInteractive() {
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

    // Con una instancia de fondo corriendo NO se busca update desde aquí:
    // el exe está bloqueado por ella y el reemplazo fallaría; ella misma se
    // actualiza sola (al arrancar y cada 24 h).
    let running = await queryRunningInstance();
    if (!running) await checkForUpdates();

    const settings = loadSettings();

    if (!running && settings.autostart === 'on') {
        console.log('♻️  El modo automático está activado pero no estaba corriendo. Lo arranco...');
        launchBackgroundInstance();
        await new Promise(r => setTimeout(r, 1500));
        running = await queryRunningInstance();
    }

    if (running) return interactiveMenu(running);

    if (settings.autostart === undefined && process.platform === 'win32') {
        if (await promptActivation()) {
            if (await activateAutomaticMode()) return;
        } else {
            saveSettings({ autostart: 'no' });
            console.log('\n👍 Va, seguimos como antes.');
        }
    }

    await runManualWatch(loadSettings());
}

if (require.main === module) {
    (IS_BACKGROUND ? runBackground() : runInteractive()).catch(console.error);
} else {
    module.exports = {
        parseXML, resolveConfig, CONFIG, VERSION,
        extractMapCodeFromFilmName, findMapCodeFromFilms,
        buildVbsContent, isNewerVersion, loadSettings, saveSettings
    };
}
