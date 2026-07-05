/**
 * Test de Envío a Discord
 * Prueba completa de envío de stats con verificación
 */

const http = require('http');

const API_KEY = process.env.API_KEY || 'dev-key';
const SERVER_HOST = process.env.SERVER_HOST || 'localhost';
const SERVER_PORT = process.env.SERVER_PORT || 3000;

// Generar ID único para esta prueba
const gameUniqueId = `test-discord-${Date.now()}`;

console.log('╔══════════════════════════════════════════════════════════╗');
console.log('║        TEST DE ENVÍO DE STATS A DISCORD                  ║');
console.log('╚══════════════════════════════════════════════════════════╝\n');

console.log(`🎮 Game ID: ${gameUniqueId}\n`);

// Datos de prueba para un juego 4v4
const reportData = {
    gameData: {
        gameUniqueId: gameUniqueId,
        mapName: "Guardian",
        gameTypeName: "Team Slayer",
        timestamp: new Date().toISOString(),
        playlistName: "Custom Games",
        duration: 720,
        isMatchmaking: false
    },
    players: [
        // Blue Team (TeamId: 0)
        { gamertag: "iChocko", kills: 25, deaths: 15, assists: 8, score: 25, teamId: 0, serviceId: "B1", killingSpree: 10 },
        { gamertag: "Pyro Master", kills: 18, deaths: 12, assists: 10, score: 18, teamId: 0, serviceId: "B2", killingSpree: 6 },
        { gamertag: "Ghost Rider", kills: 15, deaths: 14, assists: 12, score: 15, teamId: 0, serviceId: "B3", killingSpree: 5 },
        { gamertag: "Shadow Fox", kills: 12, deaths: 16, assists: 15, score: 12, teamId: 0, serviceId: "B4", killingSpree: 4 },
        // Red Team (TeamId: 1)
        { gamertag: "Spartan 117", kills: 22, deaths: 18, assists: 7, score: 22, teamId: 1, serviceId: "R1", killingSpree: 8 },
        { gamertag: "Elite Slayer", kills: 16, deaths: 15, assists: 9, score: 16, teamId: 1, serviceId: "R2", killingSpree: 6 },
        { gamertag: "Cortana AI", kills: 14, deaths: 17, assists: 11, score: 14, teamId: 1, serviceId: "R3", killingSpree: 5 },
        { gamertag: "Noble Six", kills: 10, deaths: 20, assists: 6, score: 10, teamId: 1, serviceId: "R4", killingSpree: 3 }
    ],
    filename: `${gameUniqueId}.xml`
};

// Calcular scores de equipo
const blueScore = reportData.players.filter(p => p.teamId === 0).reduce((sum, p) => sum + p.kills, 0);
const redScore = reportData.players.filter(p => p.teamId === 1).reduce((sum, p) => sum + p.kills, 0);

console.log('📊 DATOS DE LA PARTIDA:');
console.log(`   🗺️  Mapa: ${reportData.gameData.mapName}`);
console.log(`   🎯 Modo: ${reportData.gameData.gameTypeName}`);
console.log(`   🔵 Team Blue: ${blueScore} kills`);
console.log(`   🔴 Team Red: ${redScore} kills`);
console.log(`   👥 Jugadores: ${reportData.players.length}`);
console.log(`\n⏳ Enviando al servidor en ${SERVER_HOST}:${SERVER_PORT}...\n`);

const data = JSON.stringify(reportData);

const options = {
    hostname: SERVER_HOST,
    port: SERVER_PORT,
    path: '/api/report',
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'X-API-Key': API_KEY,
        'Content-Length': data.length
    }
};

const req = http.request(options, (res) => {
    let responseBody = '';

    res.on('data', (chunk) => {
        responseBody += chunk;
    });

    res.on('end', () => {
        console.log('╔══════════════════════════════════════════════════════════╗');
        console.log('║                  RESULTADO DEL ENVÍO                     ║');
        console.log('╚══════════════════════════════════════════════════════════╝\n');

        console.log(`📡 Status HTTP: ${res.statusCode}`);

        try {
            const response = JSON.parse(responseBody);
            console.log(`📦 Respuesta del servidor:`, JSON.stringify(response, null, 2));

            if (res.statusCode === 200 && response.status === 'processed') {
                console.log('\n✅ ¡PRUEBA EXITOSA!');
                console.log('   ✅ El reporte fue procesado correctamente');
                console.log('   ✅ La imagen fue generada');
                console.log('   ✅ Los datos fueron guardados en Supabase');
                console.log('   ✅ El mensaje fue enviado a Discord');
                console.log('\n💬 Por favor verifica el canal de Discord para confirmar que llegó el mensaje.');

            } else if (response.status === 'duplicate') {
                console.log('\n⚠️  ADVERTENCIA: Juego duplicado');
                console.log('   ℹ️  Este juego ya fue procesado anteriormente');

            } else {
                console.log('\n❌ ERROR: Respuesta inesperada del servidor');
            }

        } catch (e) {
            console.log(`📄 Respuesta (raw): ${responseBody}`);
        }

        console.log('\n' + '═'.repeat(60) + '\n');
    });
});

req.on('error', (error) => {
    console.error('\n❌ ERROR DE CONEXIÓN:');
    console.error(`   ${error.message}`);
    console.error('\n⚠️  Asegúrate de que el servidor esté corriendo:');
    console.error('   cd server && npm start\n');
    process.exit(1);
});

req.write(data);
req.end();
