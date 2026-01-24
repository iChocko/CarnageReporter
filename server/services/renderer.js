/**
 * Renderer Service
 * Generación de imágenes PNG con Puppeteer AISLADO
 *
 * IMPORTANTE: Usa una instancia de Puppeteer completamente separada
 * de WhatsApp para evitar conflictos de "detached Frame"
 */

const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

class RendererService {
    constructor() {
        // Directorio SEPARADO para el renderer (diferente al de WhatsApp)
        this.profileDir = '/tmp/.puppeteer_renderer';

        // Crear directorio de perfil
        if (!fs.existsSync(this.profileDir)) {
            fs.mkdirSync(this.profileDir, { recursive: true });
        }

        // Detectar Chromium
        this.executablePath = this.getChromiumPath();
    }

    /**
     * Detecta la ruta de Chromium en el sistema
     */
    getChromiumPath() {
        const possiblePaths = [
            '/snap/bin/chromium',
            '/usr/bin/chromium-browser',
            '/usr/bin/chromium',
            '/usr/bin/google-chrome-stable',
            '/usr/bin/google-chrome',
        ];

        for (const p of possiblePaths) {
            if (fs.existsSync(p)) {
                console.log(`🌐 Chromium detectado: ${p}`);
                return p;
            }
        }

        return process.env.PUPPETEER_EXECUTABLE_PATH || null;
    }

    /**
     * Genera el HTML del reporte de partida
     */
    generateHTML(gameData, players) {
        const blueTeam = players.filter(p => p.teamId === 0);
        const redTeam = players.filter(p => p.teamId === 1);

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

        const timestamp = new Date(gameData.timestamp);
        const options = { timeZone: 'America/Mexico_City', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false };
        const cdmxParts = new Intl.DateTimeFormat('en-GB', options).formatToParts(timestamp);

        const getPart = (type) => cdmxParts.find(p => p.type === type).value;
        const formatDate = () => `${getPart('year')}-${getPart('month')}-${getPart('day')}`;
        const formatTime = () => `${getPart('hour')}:${getPart('minute')}:${getPart('second')}`;

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
        <div class="bg-opacity-50 bg-black p-6 rounded-t-lg border-b border-gray-800 flex justify-between items-end">
            <div>
                <h2 class="text-xs uppercase tracking-[0.3em] text-cyan-500 mb-1 font-semibold">Post Game Carnage Report</h2>
                <h1 class="text-4xl font-halo font-bold text-white uppercase glow-text tracking-wider">${gameData.mapName}</h1>
                <div class="text-gray-400 text-sm mt-1 font-mono tracking-wide">ID: <span class="text-gray-300">${gameData.gameUniqueId}</span></div>
            </div>
            <div class="text-right">
                <div class="text-xs uppercase tracking-widest text-gray-500 mb-1">Date Played</div>
                <div class="text-xl font-halo text-gray-200">${formatDate(timestamp)}</div>
                <div class="text-sm font-halo text-gray-400">${formatTime(timestamp)}</div>
            </div>
        </div>

        <div class="p-8 space-y-8 bg-gradient-to-b from-gray-900 via-[#0a1116] to-black">
            <div class="winner-banner py-4 text-center mb-8">
                <h2 class="text-3xl font-halo font-bold ${blueWins ? 'text-halo-blue' : 'text-halo-red'} uppercase tracking-[0.2em]">${winnerText}</h2>
            </div>

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

        <div class="bg-black bg-opacity-80 p-4 text-center border-t border-gray-800 rounded-b-lg">
            <p class="text-gray-600 text-xs font-mono tracking-widest uppercase">CarnageReporter Server v1.0 // H3MCC // ${gameData.gameTypeName}</p>
        </div>
    </div>
</body>
</html>`;
    }

    /**
     * Genera un PNG a partir de los datos del juego
     * Usa una instancia de Puppeteer COMPLETAMENTE AISLADA
     */
    async generatePNG(gameData, players, outputPath) {
        const htmlContent = this.generateHTML(gameData, players);
        let browser = null;

        try {
            // Crear instancia NUEVA y AISLADA de Puppeteer para cada renderizado
            const launchOptions = {
                headless: 'new',
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-accelerated-2d-canvas',
                    '--disable-gpu',
                    '--disable-software-rasterizer',
                    '--disable-extensions',
                    '--disable-background-networking',
                    '--disable-default-apps',
                    '--disable-sync',
                    '--disable-translate',
                    '--hide-scrollbars',
                    '--metrics-recording-only',
                    '--mute-audio',
                    '--no-first-run',
                    '--safebrowsing-disable-auto-update',
                ],
                // Directorio de datos DIFERENTE al de WhatsApp
                userDataDir: this.profileDir,
                // Timeout más corto para evitar cuelgues
                timeout: 30000,
            };

            if (this.executablePath) {
                launchOptions.executablePath = this.executablePath;
            }

            browser = await puppeteer.launch(launchOptions);
            const page = await browser.newPage();

            // Configurar viewport y timeout
            await page.setViewport({ width: 1200, height: 1000 });
            page.setDefaultTimeout(15000);

            // Cargar contenido
            await page.setContent(htmlContent, {
                waitUntil: 'networkidle0',
                timeout: 15000
            });

            // Capturar screenshot
            await page.screenshot({
                path: outputPath,
                fullPage: true,
                type: 'png'
            });

            console.log(`📸 PNG generado: ${outputPath}`);
            return outputPath;

        } catch (error) {
            console.error('❌ Error generando PNG:', error.message);
            throw error;
        } finally {
            // SIEMPRE cerrar el browser para liberar recursos
            if (browser) {
                try {
                    await browser.close();
                } catch (e) {
                    // Ignorar errores al cerrar
                }
            }
        }
    }
}

module.exports = RendererService;
