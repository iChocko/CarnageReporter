/**
 * Renderer Service
 * Generación de imágenes PNG con Puppeteer AISLADO.
 *
 * Diseño: "Post Game Carnage Report" estilo Halo 3 clásico (Bungie).
 * Sin dependencias de red: todo el CSS es inline y la tipografía es de sistema.
 */

const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Paleta de equipos estilo Halo 3 (convención del proyecto: 0=Blue, 1=Red)
const TEAM_PALETTE = {
    0: { name: 'BLUE TEAM', main: '#4f8fca', dark: '#12283d', light: '#8fc3ef' },
    1: { name: 'RED TEAM', main: '#c94f4f', dark: '#3d1212', light: '#ef8f8f' },
    2: { name: 'GREEN TEAM', main: '#5cae5c', dark: '#143d14', light: '#9fe09f' },
    3: { name: 'ORANGE TEAM', main: '#d98e3c', dark: '#3d2812', light: '#f0bc85' },
    4: { name: 'PURPLE TEAM', main: '#9a5cc9', dark: '#28123d', light: '#cda1ec' },
    5: { name: 'GOLD TEAM', main: '#c9b23c', dark: '#3d3512', light: '#ecd985' },
    6: { name: 'BROWN TEAM', main: '#a1794f', dark: '#2e2012', light: '#cfae87' },
    7: { name: 'PINK TEAM', main: '#d97ca8', dark: '#3d1228', light: '#f2b0cf' },
};

function getTeam(teamId) {
    return TEAM_PALETTE[teamId] || { name: `TEAM ${teamId}`, main: '#8a9aaa', dark: '#1c242c', light: '#c0ccd8' };
}

function escapeHtml(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function formatDuration(seconds) {
    if (!seconds || seconds <= 0) return null;
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
}

function fmtKD(kills, deaths) {
    return deaths > 0 ? (kills / deaths).toFixed(2) : kills.toFixed(2);
}

class RendererService {
    constructor() {
        // Directorio SEPARADO para el renderer
        this.profileDir = path.join(os.tmpdir(), '.puppeteer_renderer');

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
            '/usr/bin/chromium',
            '/usr/bin/chromium-browser',
            '/usr/bin/google-chrome-stable',
            '/usr/bin/google-chrome',
            '/snap/bin/chromium',
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
     * Fila de un jugador (modo equipos o FFA)
     */
    playerRow(p, accentColor, place) {
        const kd = fmtKD(p.kills, p.deaths);
        const spree = p.killingSpree || p.mostKillsInARow || 0;
        return `
            <tr>
                <td class="c place">${place}</td>
                <td class="player">
                    <span class="tag" style="border-color:${accentColor}">${escapeHtml(p.serviceId || p.clanTag || '—')}</span>
                    <span class="name">${escapeHtml(p.gamertag)}</span>
                </td>
                <td class="c score">${p.score}</td>
                <td class="c">${p.kills}</td>
                <td class="c dim">${p.deaths}</td>
                <td class="c dim">${p.assists}</td>
                <td class="c kd" style="color:${accentColor}">${kd}</td>
                <td class="c dim">${spree}</td>
            </tr>`;
    }

    tableHead() {
        return `
            <thead>
                <tr>
                    <th class="c w-place">PLACE</th>
                    <th class="w-player">PLAYER</th>
                    <th class="c">SCORE</th>
                    <th class="c">KILLS</th>
                    <th class="c">DEATHS</th>
                    <th class="c">ASSISTS</th>
                    <th class="c">K/D</th>
                    <th class="c">SPREE</th>
                </tr>
            </thead>`;
    }

    /**
     * Genera el HTML del reporte de partida (estilo Halo 3 clásico)
     */
    generateHTML(gameData, players) {
        const isTeams = gameData.isTeamsEnabled !== false;
        const shortId = String(gameData.gameUniqueId || 'unknown').slice(0, 8);
        const duration = formatDuration(gameData.duration);

        // Fecha/hora en horario de CDMX
        const timestamp = new Date(gameData.timestamp);
        const options = { timeZone: 'America/Mexico_City', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false };
        const parts = new Intl.DateTimeFormat('en-GB', options).formatToParts(timestamp);
        const getPart = (type) => (parts.find(p => p.type === type) || {}).value || '';
        const dateStr = `${getPart('day')}/${getPart('month')}/${getPart('year')}`;
        const timeStr = `${getPart('hour')}:${getPart('minute')}`;

        let winnerText, winnerColor, bodyContent;

        if (isTeams) {
            // ---- MODO EQUIPOS (2 o más) ----
            const teamsMap = new Map();
            for (const p of players) {
                const tid = p.teamId ?? 0;
                if (!teamsMap.has(tid)) teamsMap.set(tid, []);
                teamsMap.get(tid).push(p);
            }

            const teams = [...teamsMap.entries()].map(([tid, members]) => {
                const totals = members.reduce((acc, p) => ({
                    score: acc.score + p.score,
                    kills: acc.kills + p.kills,
                    deaths: acc.deaths + p.deaths,
                    assists: acc.assists + p.assists,
                }), { score: 0, kills: 0, deaths: 0, assists: 0 });
                return { tid, meta: getTeam(tid), members: [...members].sort((a, b) => b.score - a.score), totals };
            }).sort((a, b) => b.totals.score - a.totals.score);

            // Ganador (maneja empates)
            if (teams.length >= 2 && teams[0].totals.score === teams[1].totals.score) {
                winnerText = 'DRAW';
                winnerColor = '#c8d2dc';
            } else {
                winnerText = `${teams[0].meta.name} WINS`;
                winnerColor = teams[0].meta.light;
            }

            bodyContent = teams.map(team => {
                const kd = fmtKD(team.totals.kills, team.totals.deaths);
                let place = 0;
                return `
            <section class="team">
                <div class="team-bar" style="background:linear-gradient(90deg, ${team.meta.dark} 0%, rgba(10,15,20,0.4) 85%); border-left:5px solid ${team.meta.main};">
                    <span class="team-name" style="color:${team.meta.light}">${team.meta.name}</span>
                    <span class="team-score" style="color:${team.meta.light}">${team.totals.score}</span>
                </div>
                <table>
                    ${this.tableHead()}
                    <tbody>
                        ${team.members.map(p => this.playerRow(p, team.meta.light, ++place)).join('')}
                        <tr class="totals" style="border-top:1px solid ${team.meta.main}">
                            <td class="c"></td>
                            <td class="player total-label" style="color:${team.meta.light}">TEAM TOTALS</td>
                            <td class="c score">${team.totals.score}</td>
                            <td class="c">${team.totals.kills}</td>
                            <td class="c dim">${team.totals.deaths}</td>
                            <td class="c dim">${team.totals.assists}</td>
                            <td class="c kd" style="color:${team.meta.light}">${kd}</td>
                            <td class="c"></td>
                        </tr>
                    </tbody>
                </table>
            </section>`;
            }).join('');

        } else {
            // ---- MODO FFA (cada quien por su lado) ----
            const sorted = [...players].sort((a, b) => (a.standing - b.standing) || (b.score - a.score));
            const winner = sorted[0];
            winnerText = winner ? `${escapeHtml(winner.gamertag).toUpperCase()} WINS` : 'GAME OVER';
            winnerColor = '#e8d98a';

            let place = 0;
            bodyContent = `
            <section class="team">
                <div class="team-bar" style="background:linear-gradient(90deg, #2e2a14 0%, rgba(10,15,20,0.4) 85%); border-left:5px solid #c9b23c;">
                    <span class="team-name" style="color:#ecd985">FREE FOR ALL</span>
                    <span class="team-score" style="color:#ecd985">${players.length} SPARTANS</span>
                </div>
                <table>
                    ${this.tableHead()}
                    <tbody>
                        ${sorted.map(p => this.playerRow(p, '#ecd985', ++place)).join('')}
                    </tbody>
                </table>
            </section>`;
        }

        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Post Game Carnage Report</title>
<style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
        background:
            radial-gradient(ellipse at 50% -20%, #1c2c3e 0%, transparent 60%),
            linear-gradient(180deg, #0b1119 0%, #0e1620 45%, #0a0e14 100%);
        color: #c8d2dc;
        font-family: 'Arial Narrow', 'Segoe UI', 'Helvetica Neue', Arial, sans-serif;
        padding: 34px 40px;
        width: 1200px;
    }
    .frame {
        border: 1px solid #2a3a4c;
        background: rgba(13, 20, 28, 0.88);
        box-shadow: 0 0 0 1px rgba(120,160,200,0.06), 0 18px 60px rgba(0,0,0,0.7);
    }

    /* --- Encabezado --- */
    header {
        display: flex; justify-content: space-between; align-items: flex-end;
        padding: 22px 28px 16px 28px;
        background: linear-gradient(180deg, rgba(46,66,88,0.5) 0%, rgba(18,26,36,0.2) 100%);
        border-bottom: 1px solid #33475c;
    }
    .kicker {
        font-size: 13px; letter-spacing: 5px; color: #7fa8c9;
        text-transform: uppercase; margin-bottom: 4px;
    }
    h1 {
        font-size: 44px; font-weight: 700; letter-spacing: 3px;
        color: #eef3f8; text-transform: uppercase;
        text-shadow: 0 2px 12px rgba(90,140,190,0.35);
    }
    .gametype { font-size: 17px; letter-spacing: 2px; color: #93a6b8; text-transform: uppercase; margin-top: 4px; }
    .meta { text-align: right; font-size: 15px; color: #7d8fa0; letter-spacing: 1px; line-height: 1.55; }
    .meta b { color: #b9c9d8; font-weight: 700; }

    /* --- Banner de ganador --- */
    .winner {
        text-align: center; padding: 13px 0;
        border-top: 1px solid rgba(140,180,220,0.28);
        border-bottom: 1px solid rgba(140,180,220,0.28);
        background: linear-gradient(90deg, transparent 0%, rgba(90,130,175,0.16) 50%, transparent 100%);
    }
    .winner h2 { font-size: 30px; letter-spacing: 8px; font-weight: 700; text-transform: uppercase; }

    /* --- Equipos y tablas --- */
    .content { padding: 22px 28px 10px 28px; }
    .team { margin-bottom: 24px; }
    .team-bar {
        display: flex; justify-content: space-between; align-items: center;
        padding: 9px 16px; margin-bottom: 2px;
    }
    .team-name { font-size: 21px; font-weight: 700; letter-spacing: 4px; }
    .team-score { font-size: 26px; font-weight: 700; letter-spacing: 1px; }

    table { width: 100%; border-collapse: collapse; }
    th {
        font-size: 12px; letter-spacing: 2px; color: #6e8093;
        padding: 8px 10px 6px 10px; border-bottom: 1px solid #2a3a4c;
        text-align: left; font-weight: 700;
    }
    td {
        padding: 9px 10px; font-size: 17px;
        border-bottom: 1px solid rgba(90,120,150,0.12);
        background: linear-gradient(180deg, rgba(70,100,135,0.05) 0%, rgba(20,30,40,0.05) 100%);
    }
    tr:nth-child(odd) td { background: rgba(70,100,135,0.09); }
    .c { text-align: center; }
    .w-place { width: 64px; }
    .w-player { width: 34%; }
    .place { color: #6e8093; font-weight: 700; }
    .player .name { font-weight: 700; color: #e8eef4; letter-spacing: 0.5px; }
    .player .tag {
        display: inline-block; min-width: 40px; text-align: center;
        font-size: 12px; letter-spacing: 1px; color: #9fb2c4;
        border: 1px solid #44586c; padding: 2px 6px; margin-right: 10px;
        background: rgba(20,30,42,0.7);
    }
    .score { font-weight: 700; color: #f0e6b4; }
    .kd { font-weight: 700; }
    .dim { color: #8b9cad; }
    .totals td { font-size: 16px; border-bottom: none; background: rgba(25,36,48,0.75) !important; }
    .total-label { font-weight: 700; letter-spacing: 2px; font-size: 14px; }

    /* --- Pie --- */
    footer {
        display: flex; justify-content: space-between; align-items: center;
        padding: 12px 28px; border-top: 1px solid #2a3a4c;
        background: rgba(9, 14, 20, 0.85);
        font-size: 12.5px; letter-spacing: 1.5px; color: #5c6f82; text-transform: uppercase;
    }
    footer .gid b { color: #9fb2c4; font-size: 14px; letter-spacing: 2px; }
    footer .gid span { color: #46586a; }
</style>
</head>
<body>
    <div class="frame">
        <header>
            <div>
                <div class="kicker">Post Game Carnage Report</div>
                <h1>${escapeHtml(gameData.mapName)}</h1>
                ${gameData.gameTypeName && gameData.gameTypeName !== gameData.mapName
                    ? `<div class="gametype">${escapeHtml(gameData.gameTypeName)}</div>` : ''}
            </div>
            <div class="meta">
                <div><b>${dateStr}</b> &nbsp;${timeStr} hrs</div>
                ${duration ? `<div>Duración: <b>${duration}</b></div>` : ''}
                <div>${players.length} jugadores</div>
            </div>
        </header>

        <div class="winner"><h2 style="color:${winnerColor}">${winnerText}</h2></div>

        <div class="content">
            ${bodyContent}
        </div>

        <footer>
            <div class="gid">ID: <b>${escapeHtml(shortId)}</b> <span>· ${escapeHtml(gameData.gameUniqueId || '')}</span></div>
            <div>Carnage Reporter · H3 MCC</div>
        </footer>
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
                // Directorio de datos aislado para el renderer
                userDataDir: this.profileDir,
                // Timeout más corto para evitar cuelgues
                timeout: 30000,
            };

            if (this.executablePath) {
                launchOptions.executablePath = this.executablePath;
            }

            browser = await puppeteer.launch(launchOptions);
            const page = await browser.newPage();

            // Configurar viewport y timeout (altura baja: fullPage crece al contenido
            // y así las partidas cortas no dejan espacio vacío abajo)
            await page.setViewport({ width: 1200, height: 400 });
            page.setDefaultTimeout(15000);

            // Cargar contenido (sin dependencias de red: basta el DOM)
            await page.setContent(htmlContent, {
                waitUntil: 'domcontentloaded',
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
