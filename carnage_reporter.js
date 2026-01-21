/**
 * CarnageReporter - Unified Script
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const { XMLParser } = require('fast-xml-parser');
const puppeteer = require('puppeteer');
const { Client, RemoteAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const chokidar = require('chokidar');
const { createClient } = require('@supabase/supabase-js');
const { SupabaseStore } = require('./supabase_store');

// ============== CONFIGURATION ==============
const CONFIG = {
    // WhatsApp group name
    targetGroupName: 'H3MCC',

    // Discord webhook URL (para el canal #general de 'Cappel Halo 3')
    discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL || 'https://discord.com/api/webhooks/1439791121084448861/-8tTj6hzw27RoWwDhdyYCBWMUXw8_u_X8WDjJXBgtNvUxd0A8Nutjw3YWkTPx2d58',

    // Supabase credentials (embedded for portability)
    supabaseUrl: 'https://isxjfvrdnmrwxyzfbvua.supabase.co',
    supabaseKey: 'sb_secret_bgUkXG9EjVga3lIy8k-StA_W_I6VDGa',

    // Paths (use process.cwd() when running as EXE to avoid read-only snapshot errors)
    outputDir: path.join(process.cwd(), 'output'),
    htmlTemplatePath: path.join(__dirname, 'match_summary.html'),

    // Map name lookup (MCC XML files use internal names)
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
    }
};

// ============== UTILITY FUNCTIONS ==============

/**
 * Intenta encontrar la ruta de Chrome o Edge en Windows
 * para que Puppeteer funcione sin descargar un binario propio.
 */
function getEdgeOrChromePath() {
    if (process.platform !== 'win32') return null;

    const paths = [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        path.join(os.homedir(), 'AppData\\Local\\Google\\Chrome\\Application\\chrome.exe')
    ];

    for (const p of paths) {
        if (fs.existsSync(p)) return p;
    }
    return null;
}

function getMapName(filename, gameData = {}) {
    const fn = filename.toLowerCase();
    for (const [key, val] of Object.entries(CONFIG.maps)) {
        if (fn.includes(key)) return val;
    }

    // Fallback if no mapping found
    if (gameData.hopperName && gameData.hopperName !== 'Unknown' && gameData.hopperName !== '') {
        return gameData.hopperName;
    }

    // Check if it's a known generic name
    if (fn.includes('mpcarnagereport')) return 'Halo 3 Match';

    return 'Halo 3 Map';
}

function getMCCTempPath() {
    // Standard Windows path for Halo MCC carnage reports
    const windowsPath = path.join(os.homedir(), 'AppData', 'LocalLow', 'MCC', 'Temporary');
    // Also check for a local Maps_to_Rename folder (for dev/testing)
    const localPath = path.join(__dirname, 'Maps_to_Rename');

    // prioritize localPath if it exists (for developer testing)
    if (fs.existsSync(localPath)) {
        console.log('📁 Using local Maps_to_Rename folder for testing');
        return localPath;
    }

    // If not windowsPath exists, we assume we are on a user's machine and should use it
    // If it doesn't exist, we create it (or the local one as fallback)
    if (process.platform === 'win32') {
        if (!fs.existsSync(windowsPath)) {
            try {
                fs.mkdirSync(windowsPath, { recursive: true });
            } catch (e) {
                console.log(`⚠️  Could not create Windows MCC path: ${e.message}`);
            }
        }
        if (fs.existsSync(windowsPath)) {
            console.log(`📁 Watching MCC Temporary folder: ${windowsPath}`);
            return windowsPath;
        }
    }

    // Default fallback
    if (!fs.existsSync(localPath)) {
        fs.mkdirSync(localPath, { recursive: true });
    }
    console.log(`📁 Watching folder for XMLs: ${localPath}`);
    return localPath;
}

function parseTimestamp(filename) {
    // Format: CYR1X-2026-01-20-18-14-04-mpcarnagereport1_3528_0_0.xml
    const match = filename.match(/(\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2})/);
    if (match) {
        return new Date(match[1].replace(/-/g, (m, i) => i > 7 ? ':' : '-').replace(/:/, 'T').replace(/:/, ':').slice(0, 19).replace(/-(\d{2})-(\d{2})-(\d{2})$/, 'T$1:$2:$3'));
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
    const root = result.CarnageReport || result;

    // Extract game data
    const hopperName = root.HopperName?.HopperName || 'Unknown';
    const gameData = {
        gameUniqueId: root.GameUniqueId?.GameUniqueId || 'unknown',
        gameEnum: parseInt(root.GameEnum?.mGameEnum || 0),
        isMatchmaking: root.IsMatchmaking?.IsMatchmaking === 'true',
        isTeamsEnabled: root.IsTeamsEnabled?.IsTeamsEnabled === 'true',
        hopperName: hopperName,
        gameTypeName: root.GameTypeName?.GameTypeName || 'Slayer',
        timestamp: parseTimestamp(path.basename(filePath)),
    };
    gameData.mapName = getMapName(path.basename(filePath), gameData);

    // Extract players
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

// ============== HTML GENERATION ==============

function generateMatchSummaryHTML(gameData, players) {
    // Group players by team
    const blueTeam = players.filter(p => p.teamId === 0);
    const redTeam = players.filter(p => p.teamId === 1);

    // Calculate team totals
    const calcTotals = (team) => ({
        kills: team.reduce((sum, p) => sum + p.kills, 0),
        score: team.reduce((sum, p) => sum + p.score, 0),
        deaths: team.reduce((sum, p) => sum + p.deaths, 0),
        assists: team.reduce((sum, p) => sum + p.assists, 0)
    });

    const blueTotals = calcTotals(blueTeam);
    const redTotals = calcTotals(redTeam);

    const blueWins = blueTotals.score > redTotals.score;
    const winnerText = blueWins ? 'Blue Team Victory' : 'Red Team Victory';

    const formatDate = (d) => d.toISOString().split('T')[0];
    const formatTime = (d) => d.toTimeString().split(' ')[0];

    const playerRow = (p, isBlue) => {
        const kd = p.deaths > 0 ? (p.kills / p.deaths).toFixed(2) : p.kills.toFixed(2);
        const teamColorClass = isBlue ? 'blue' : 'red';
        const initials = p.gamertag.slice(0, 2).toUpperCase();

        return `
            <tr class="hover:bg-white hover:bg-opacity-[0.03] transition-colors">
                <td class="pl-4 py-3">
                    <div class="flex items-center gap-3">
                        <div class="w-8 h-8 bg-${teamColorClass}-900 rounded border border-${teamColorClass}-700 flex items-center justify-center text-xs font-bold ring-1 ring-${teamColorClass}-500/50">
                            ${initials}
                        </div>
                        <div>
                            <div class="font-bold tracking-wide text-white">${p.gamertag}</div>
                            <div class="text-xs text-gray-500 uppercase tracking-wider font-semibold">
                                Service Tag: ${p.serviceId || p.clanTag || 'N/A'}</div>
                        </div>
                    </div>
                </td>
                <td class="text-center stat-val text-white text-lg">${p.kills}</td>
                <td class="text-center stat-val text-halo-gold font-bold text-xl">${p.score}</td>
                <td class="text-center stat-val text-gray-400">${p.deaths}</td>
                <td class="text-center stat-val text-gray-400">${p.assists}</td>
                <td class="text-center stat-val text-halo-${teamColorClass}">${kd}</td>
                <td class="text-center stat-val text-red-400 pr-4">${p.deaths}</td>
            </tr>`;
    };

    const teamTotalsRow = (totals, isBlue) => {
        const kd = totals.deaths > 0 ? (totals.kills / totals.deaths).toFixed(2) : totals.kills.toFixed(2);
        const teamColorClass = isBlue ? 'blue' : 'red';
        const teamName = isBlue ? 'BLUE' : 'RED';

        return `
            <tr class="bg-${teamColorClass}-900 bg-opacity-20 border-t border-${teamColorClass}-800">
                <td class="pl-4 py-3 font-halo font-bold text-halo-${teamColorClass} tracking-wider text-sm">${teamName} TOTALS</td>
                <td class="text-center stat-val text-white font-bold text-lg">${totals.kills}</td>
                <td class="text-center stat-val text-white font-bold text-lg">${totals.score}</td>
                <td class="text-center stat-val text-gray-300">${totals.deaths}</td>
                <td class="text-center stat-val text-gray-300">${totals.assists}</td>
                <td class="text-center stat-val text-halo-${teamColorClass}">${kd}</td>
                <td class="text-center stat-val text-gray-300 pr-4">${totals.deaths}</td>
            </tr>`;
    };

    // Read base template and inject dynamic content
    const baseHTML = fs.readFileSync(CONFIG.htmlTemplatePath, 'utf-8');

    // For now, generate a complete HTML (can optimize later to use template injection)
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Post Game Carnage Report</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@400;500;700;900&family=Rajdhani:wght@300;400;500;600;700&display=swap" rel="stylesheet">
    <style>
        body { background-color: #0a141d; color: #e0e6eb; font-family: 'Rajdhani', sans-serif; overflow: hidden; }
        .font-halo { font-family: 'Orbitron', sans-serif; }
        .glass-panel { background: rgba(18, 38, 54, 0.85); backdrop-filter: blur(16px); border: 1px solid rgba(130, 215, 255, 0.25); box-shadow: 0 10px 40px rgba(0, 0, 0, 0.6); }
        .text-halo-blue { color: #4fc3f7; text-shadow: 0 0 10px rgba(79, 195, 247, 0.6); }
        .text-halo-red { color: #ef5350; text-shadow: 0 0 10px rgba(239, 83, 80, 0.6); }
        .text-halo-gold { color: #ffd700; text-shadow: 0 0 10px rgba(255, 215, 0, 0.5); }
        .team-header-blue { background: linear-gradient(90deg, rgba(1, 46, 74, 0.9) 0%, rgba(9, 25, 38, 0.2) 100%); border-left: 4px solid #4fc3f7; }
        .team-header-red { background: linear-gradient(90deg, rgba(66, 11, 11, 0.9) 0%, rgba(38, 9, 9, 0.2) 100%); border-left: 4px solid #ef5350; }
        .winner-banner { background: linear-gradient(90deg, transparent, rgba(79, 195, 247, 0.2), transparent); border-top: 1px solid #4fc3f7; border-bottom: 1px solid #4fc3f7; }
        th { text-transform: uppercase; font-size: 0.75rem; letter-spacing: 0.1em; color: #90a4ae; padding-bottom: 0.5rem; border-bottom: 1px solid rgba(255, 255, 255, 0.1); }
        td { padding: 0.75rem 0.5rem; border-bottom: 1px solid rgba(255, 255, 255, 0.08); font-weight: 500; }
        .stat-val { font-family: 'Orbitron', sans-serif; letter-spacing: 0.05em; }
        .glow-text { text-shadow: 0 0 8px rgba(255, 255, 255, 0.3); }
    </style>
</head>
<body class="min-h-screen flex flex-col items-center justify-center p-8">
    <div class="w-full max-w-5xl glass-panel rounded-lg p-1">
        <!-- Header -->
        <div class="bg-opacity-50 bg-black p-6 rounded-t-lg border-b border-gray-800 flex justify-between items-end">
            <div>
                <h2 class="text-xs uppercase tracking-[0.3em] text-cyan-500 mb-1 font-semibold">Post Game Carnage Report</h2>
                <h1 class="text-4xl font-halo font-bold text-white uppercase glow-text tracking-wider">${gameData.mapName}</h1>
                <div class="text-gray-400 text-sm mt-1 font-mono tracking-wide">ID: <span class="text-gray-300">${gameData.gameUniqueId}</span></div>
            </div>
            <div class="text-right">
                <div class="text-xs uppercase tracking-widest text-gray-500 mb-1">Date Played</div>
                <div class="text-xl font-halo text-gray-200">${formatDate(gameData.timestamp)}</div>
                <div class="text-sm font-halo text-gray-400">${formatTime(gameData.timestamp)}</div>
            </div>
        </div>

        <!-- Content -->
        <div class="p-8 space-y-8 bg-gradient-to-b from-gray-900 via-[#0a1116] to-black">
            <!-- Winner Banner -->
            <div class="winner-banner py-4 text-center mb-8">
                <h2 class="text-3xl font-halo font-bold ${blueWins ? 'text-halo-blue' : 'text-halo-red'} uppercase tracking-[0.2em]">${winnerText}</h2>
            </div>

            <!-- Blue Team -->
            <div class="relative">
                <div class="team-header-blue p-3 mb-4 flex justify-between items-center rounded-r">
                    <div class="flex items-center gap-3">
                        <div class="w-2 h-8 bg-[#4fc3f7] rounded-sm mx-2"></div>
                        <h3 class="text-2xl font-halo font-bold text-white tracking-wider">COBRA <span class="text-sm text-halo-blue opacity-80 ml-2">BLUE TEAM</span></h3>
                    </div>
                    <div class="text-3xl font-halo font-bold text-halo-blue mr-4">${blueTotals.score}</div>
                </div>
                <table class="w-full text-left border-collapse">
                    <thead>
                        <tr>
                            <th class="pl-4 w-1/4">Player</th>
                            <th class="text-center">Kills</th>
                            <th class="text-center">Score</th>
                            <th class="text-center">Deaths</th>
                            <th class="text-center">Assists</th>
                            <th class="text-center">K/D</th>
                            <th class="text-center pr-4">Total Deaths</th>
                        </tr>
                    </thead>
                    <tbody class="text-gray-300">
                        ${blueTeam.map(p => playerRow(p, true)).join('')}
                        ${teamTotalsRow(blueTotals, true)}
                    </tbody>
                </table>
            </div>

            <!-- Red Team -->
            <div class="relative mt-8">
                <div class="team-header-red p-3 mb-4 flex justify-between items-center rounded-r">
                    <div class="flex items-center gap-3">
                        <div class="w-2 h-8 bg-[#ef5350] rounded-sm mx-2"></div>
                        <h3 class="text-2xl font-halo font-bold text-white tracking-wider">EAGLE <span class="text-sm text-halo-red opacity-80 ml-2">RED TEAM</span></h3>
                    </div>
                    <div class="text-3xl font-halo font-bold text-halo-red mr-4">${redTotals.score}</div>
                </div>
                <table class="w-full text-left border-collapse">
                    <thead>
                        <tr>
                            <th class="pl-4 w-1/4">Player</th>
                            <th class="text-center">Kills</th>
                            <th class="text-center">Score</th>
                            <th class="text-center">Deaths</th>
                            <th class="text-center">Assists</th>
                            <th class="text-center">K/D</th>
                            <th class="text-center pr-4">Total Deaths</th>
                        </tr>
                    </thead>
                    <tbody class="text-gray-300">
                        ${redTeam.map(p => playerRow(p, false)).join('')}
                        ${teamTotalsRow(redTotals, false)}
                    </tbody>
                </table>
            </div>
        </div>

        <!-- Footer -->
        <div class="bg-black bg-opacity-80 p-4 text-center border-t border-gray-800 rounded-b-lg">
            <p class="text-gray-600 text-xs font-mono tracking-widest uppercase">CarnageReporter v4.4 // H3MCC // ${gameData.gameTypeName}</p>
        </div>
    </div>
</body>
</html>`;
}

// ============== PNG GENERATION ==============

async function generatePNG(htmlContent, outputPath) {
    const executablePath = getEdgeOrChromePath();
    const userDataDir = path.join(process.cwd(), '.puppeteer_profile');

    // Ensure profile dir exists
    if (!fs.existsSync(userDataDir)) {
        fs.mkdirSync(userDataDir, { recursive: true });
    }

    const launchOptions = {
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-extensions'],
        headless: 'new',
        userDataDir: userDataDir
    };

    if (executablePath) {
        launchOptions.executablePath = executablePath;
        console.log(`🌐 Usando navegador del sistema: ${executablePath}`);
    }

    const browser = await puppeteer.launch(launchOptions);
    const page = await browser.newPage();
    // Estilo que le gustó al usuario (1200x1000 con fullPage)
    await page.setViewport({ width: 1200, height: 1000 });
    await page.setContent(htmlContent, { waitUntil: 'networkidle0' });

    // El usuario pidió que la imagen "match_summary_test.png" sea la main
    await page.screenshot({ path: outputPath, fullPage: true });
    await browser.close();
    console.log(`📸 PNG generado: ${outputPath}`);
    return outputPath;
}

// ============== DISCORD INTEGRATION ==============

/**
 * Envía el PNG al webhook de Discord. Si falla, genera una tabla de texto
 * y la envía como mensaje de texto.
 */
async function sendToDiscord(imagePath, gameData, players) {
    if (!CONFIG.discordWebhookUrl) {
        console.log('⚠️  Discord webhook no configurado, saltando...');
        return false;
    }

    const caption = `🏆 **${gameData.mapName}** - ${gameData.gameTypeName}\n📅 ${gameData.timestamp.toLocaleString()}\nID: \`${gameData.gameUniqueId}\``;

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

        const url = new URL(CONFIG.discordWebhookUrl);
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
                    console.error(`❌ Discord falló con status ${res.statusCode}. Enviando fallback de texto...`);
                    sendDiscordFallbackText(gameData, players).then(resolve);
                }
            });

            req.on('error', (e) => {
                console.error('❌ Error enviando a Discord:', e.message);
                sendDiscordFallbackText(gameData, players).then(resolve);
            });

            req.write(payload);
            req.end();
        });
    } catch (error) {
        console.error('❌ Error en sendToDiscord:', error.message);
        return sendDiscordFallbackText(gameData, players);
    }
}

async function sendDiscordFallbackText(gameData, players) {
    // Generar tabla de texto simple
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
    const url = new URL(CONFIG.discordWebhookUrl);
    const options = {
        hostname: url.hostname,
        path: url.pathname,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': payload.length
        }
    };

    return new Promise((resolve) => {
        const req = https.request(options, (res) => {
            console.log('📤 Tabla de texto enviada a Discord (Fallback)');
            resolve(true);
        });
        req.on('error', (e) => {
            console.error('❌ Error enviando fallback a Discord:', e.message);
            resolve(false);
        });
        req.write(payload);
        req.end();
    });
}

// ============== SUPABASE UPLOAD ==============

async function uploadToSupabase(gameData, players) {
    if (!CONFIG.supabaseKey) {
        console.log('⚠️  Supabase key not configured, skipping database upload');
        return;
    }

    const supabase = createClient(CONFIG.supabaseUrl, CONFIG.supabaseKey);

    try {
        // Insert game
        const { data: gameResult, error: gameError } = await supabase
            .from('games')
            .upsert({
                game_unique_id: gameData.gameUniqueId,
                game_enum: gameData.gameEnum,
                is_matchmaking: gameData.isMatchmaking,
                is_teams_enabled: gameData.isTeamsEnabled,
                hopper_name: gameData.hopperName,
                game_type_name: gameData.gameTypeName,
                map_name: gameData.mapName,
                timestamp: gameData.timestamp.toISOString()
            }, { onConflict: 'game_unique_id' });

        if (gameError) throw gameError;

        // Insert players
        for (const p of players) {
            const { error: playerError } = await supabase
                .from('players')
                .insert({
                    game_unique_id: gameData.gameUniqueId,
                    xbox_user_id: p.xboxUserId,
                    gamertag: p.gamertag,
                    clan_tag: p.clanTag,
                    service_id: p.serviceId,
                    team_id: p.teamId,
                    score: p.score,
                    standing: p.standing,
                    kills: p.kills,
                    deaths: p.deaths,
                    assists: p.assists,
                    betrayals: p.betrayals,
                    suicides: p.suicides,
                    most_kills_in_a_row: p.mostKillsInARow
                });

            if (playerError && !playerError.message.includes('duplicate')) {
                console.error(`⚠️  Error inserting player ${p.gamertag}:`, playerError.message);
            }
        }

        console.log(`✅ Game ${gameData.gameUniqueId} uploaded to Supabase`);
    } catch (error) {
        console.error('❌ Supabase upload error:', error.message);
    }
}

// ============== WHATSAPP CLIENT ==============

let whatsappClient = null;
let whatsappReady = false;
let targetGroup = null;

async function initWhatsApp() {
    return new Promise(async (resolve) => {
        // Crear el store de Supabase para RemoteAuth
        let store = null;
        const dataPath = path.join(process.cwd(), '.wwebjs_auth');

        if (CONFIG.supabaseUrl && CONFIG.supabaseKey) {
            try {
                store = new SupabaseStore({
                    supabaseUrl: CONFIG.supabaseUrl,
                    supabaseKey: CONFIG.supabaseKey,
                    bucketName: 'whatsapp-sessions',
                    dataPath: dataPath
                });
            } catch (e) {
                console.log('⚠️  No se pudo crear SupabaseStore, usando sesión local');
            }
        }

        // Configurar cliente con RemoteAuth (sesión compartida) o sin store (local)
        const authStrategy = store
            ? new RemoteAuth({
                clientId: 'carnage-reporter',
                dataPath: dataPath,
                store: store,
                backupSyncIntervalMs: 60000 // Sincronizar cada 1 minuto para pruebas
            })
            : null;

        whatsappClient = new Client({
            authStrategy: authStrategy,
            puppeteer: {
                args: ['--no-sandbox', '--disable-setuid-sandbox'],
                headless: true
            }
        });

        whatsappClient.on('qr', (qr) => {
            console.log('\n\n╔════════════════════════════════════════════╗');
            console.log('║     ESCANEA ESTE CÓDIGO QR CON WHATSAPP    ║');
            console.log('║  (Solo necesitas hacerlo UNA VEZ)          ║');
            console.log('╚════════════════════════════════════════════╝\n');
            qrcode.generate(qr, { small: true });
            console.log('\n');
        });

        whatsappClient.on('authenticated', () => {
            console.log('✅ WhatsApp autenticado correctamente');
        });

        whatsappClient.on('remote_session_saved', () => {
            console.log('\n╔════════════════════════════════════════════╗');
            console.log('║  ☁️  SESIÓN GUARDADA EN SUPABASE (NUBE)     ║');
            console.log('║     Tus amigos ya pueden usar el EXE       ║');
            console.log('╚════════════════════════════════════════════╝\n');
        });

        whatsappClient.on('ready', async () => {
            console.log('✅ WhatsApp listo!');
            whatsappReady = true;

            // Find the target group
            const chats = await whatsappClient.getChats();
            targetGroup = chats.find(chat => chat.isGroup && chat.name === CONFIG.targetGroupName);

            if (targetGroup) {
                console.log(`📱 Grupo encontrado: ${targetGroup.name}`);
            } else {
                console.log(`⚠️  Grupo "${CONFIG.targetGroupName}" no encontrado`);
                console.log('   Grupos disponibles:');
                chats.filter(c => c.isGroup).forEach(g => console.log(`     - ${g.name}`));
            }

            resolve();
        });

        whatsappClient.on('auth_failure', (msg) => {
            console.error('❌ Error de autenticación WhatsApp:', msg);
            resolve();
        });

        whatsappClient.initialize();
    });
}

async function sendToWhatsApp(imagePath, caption) {
    if (!whatsappReady || !targetGroup) {
        console.log('⚠️  WhatsApp no está listo o no se encontró el grupo');
        return false;
    }

    try {
        const media = MessageMedia.fromFilePath(imagePath);
        await whatsappClient.sendMessage(targetGroup.id._serialized, media, { caption });
        console.log('📤 Imagen enviada a WhatsApp!');
        return true;
    } catch (error) {
        console.error('❌ Error enviando a WhatsApp:', error.message);
        return false;
    }
}

// ============== MAIN PROCESS ==============

const processedFiles = new Set();

async function processXMLFile(filePath) {
    const filename = path.basename(filePath);

    // Skip if already processed or not a carnage report
    if (processedFiles.has(filename)) return;
    if (!filename.includes('mpcarnagereport') && !filename.includes('asq_')) return;
    if (filename.includes('test_trigger')) return;

    console.log(`\n🎮 Procesando partida: ${filename}`);
    processedFiles.add(filename);

    try {
        // 1. Parse XML
        const { gameData, players } = parseXML(filePath);
        console.log(`   Mapa: ${gameData.mapName}, Jugadores: ${players.length}`);

        // 2. Generate HTML and PNG
        const htmlContent = generateMatchSummaryHTML(gameData, players);
        // Use filename in path if gameUniqueId is unknown to avoid collisions
        const safeId = gameData.gameUniqueId !== 'unknown' ? gameData.gameUniqueId : path.basename(filePath, '.xml');
        const pngPath = path.join(CONFIG.outputDir, `match_${safeId}.png`);

        // Ensure output directory exists
        if (!fs.existsSync(CONFIG.outputDir)) {
            fs.mkdirSync(CONFIG.outputDir, { recursive: true });
        }

        await generatePNG(htmlContent, pngPath);

        // 3. Send to WhatsApp
        const caption = `🎮 ${gameData.mapName} - ${gameData.gameTypeName}\n📅 ${gameData.timestamp.toLocaleString()}`;
        await sendToWhatsApp(pngPath, caption);

        // 4. Send to Discord
        await sendToDiscord(pngPath, gameData, players);

        // 5. Upload to Supabase
        await uploadToSupabase(gameData, players);

        // 6. Cleanup XML (The user wants to avoid garbage)
        try {
            fs.unlinkSync(filePath);
            console.log(`🗑️  Archivo XML eliminado: ${filename}`);
        } catch (e) {
            console.log(`⚠️  No se pudo eliminar el XML: ${e.message}`);
        }

        console.log('✅ Partida procesada completamente');

        // Add a small delay between files to avoid rate limits (Discord 429)
        await new Promise(resolve => setTimeout(resolve, 3000));

    } catch (error) {
        console.error(`❌ Error procesando ${filename}:`, error.message);
    }
}

async function main() {
    console.log('╔══════════════════════════════════════════════════════════╗');
    console.log('║                    CARNAGE REPORTER                      ║');
    console.log('║              Halo 3 MCC Stats Tracker v4.4               ║');
    console.log('╚══════════════════════════════════════════════════════════╝\n');

    // Initialize WhatsApp first (user needs to scan QR)
    console.log('📱 Inicializando WhatsApp...\n');
    await initWhatsApp();

    // Get the watch directory
    const watchDir = getMCCTempPath();

    // Process any existing files
    console.log('\n🔍 Buscando partidas existentes...');
    const existingFiles = fs.readdirSync(watchDir).filter(f => f.endsWith('.xml'));
    console.log(`   Encontrados ${existingFiles.length} archivos XML`);

    // Start watching for new files
    console.log('\n👀 Monitoreando nuevas partidas...');
    console.log('   (Juega una partida de Halo 3 y los stats aparecerán aquí)\n');

    const watcher = chokidar.watch(path.join(watchDir, '*.xml'), {
        persistent: true,
        ignoreInitial: true, // No procesar archivos existentes (solo nuevos)
        awaitWriteFinish: {
            stabilityThreshold: 3000, // Dar un poco más de tiempo para que MCC suelte el archivo
            pollInterval: 200
        }
    });

    watcher.on('add', (filePath) => {
        processXMLFile(filePath);
    });

    watcher.on('error', (error) => {
        console.error('❌ Error en el monitor:', error);
    });

    // Keep the process running
    process.on('SIGINT', () => {
        console.log('\n\n👋 Cerrando CarnageReporter...');
        watcher.close();
        if (whatsappClient) {
            whatsappClient.destroy();
        }
        process.exit(0);
    });
}

main().catch(console.error);
