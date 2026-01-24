const http = require('http');

const API_KEY = 'h3mcc-carnage-2024-secret';
const SERVER_URL = '31.97.209.182';

// Fecha actual en CDMX para el test
const cdmxNow = new Date().toLocaleString("en-US", { timeZone: "America/Mexico_City" });
const gameUniqueId = `final-4v4-new-group-${Date.now()}`;

const reportData = {
    gameData: {
        gameUniqueId: gameUniqueId,
        mapName: "Guardian",
        gameTypeName: "Team Slayer",
        timestamp: new Date().toISOString(), // Enviamos ISO, el servidor lo convertirá a CDMX
        playlistName: "Social Slayer"
    },
    players: [
        // Blue Team (TeamId: 0)
        { gamertag: "Player_Blue_1", kills: 15, deaths: 10, assists: 5, score: 15, teamId: 0, serviceId: "B1" },
        { gamertag: "Player_Blue_2", kills: 12, deaths: 8, assists: 7, score: 12, teamId: 0, serviceId: "B2" },
        { gamertag: "Player_Blue_3", kills: 10, deaths: 12, assists: 3, score: 10, teamId: 0, serviceId: "B3" },
        { gamertag: "Player_Blue_4", kills: 13, deaths: 15, assists: 4, score: 13, teamId: 0, serviceId: "B4" },
        // Red Team (TeamId: 1)
        { gamertag: "Player_Red_1", kills: 18, deaths: 12, assists: 2, score: 18, teamId: 1, serviceId: "R1" },
        { gamertag: "Player_Red_2", kills: 14, deaths: 14, assists: 6, score: 14, teamId: 1, serviceId: "R2" },
        { gamertag: "Player_Red_3", kills: 9, deaths: 11, assists: 5, score: 9, teamId: 1, serviceId: "R3" },
        { gamertag: "Player_Red_4", kills: 7, deaths: 13, assists: 8, score: 7, teamId: 1, serviceId: "R4" }
    ],
    filename: `${gameUniqueId}.xml`
};

const data = JSON.stringify(reportData);

const options = {
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'X-API-Key': API_KEY,
        'Content-Length': data.length
    }
};

const req = http.request(SERVER_URL, options, (res) => {
    let responseBody = '';
    res.on('data', (chunk) => responseBody += chunk);
    res.on('end', () => {
        console.log(`Status: ${res.statusCode}`);
        console.log(`Response: ${responseBody}`);
    });
});

req.on('error', (error) => {
    console.error(`Error: ${error.message}`);
});

req.write(data);
req.end();
