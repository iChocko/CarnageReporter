/**
 * Test de Estadísticas de Envíos
 * Prueba para verificar que las estadísticas de envíos funcionan correctamente
 */

require('dotenv').config({ path: '../server/.env' });
const path = require('path');

// Mock de servicios para testing
class MockDiscordService {
    constructor() {
        this.sentCount = 0;
        this.failCount = 0;
    }

    async sendImage(pngPath, gameData, players) {
        console.log(`   📤 Enviando a Discord: ${gameData.mapName}`);
        // Simular envío exitoso en 90% de casos
        const success = Math.random() > 0.1;
        if (success) {
            this.sentCount++;
            return true;
        } else {
            this.failCount++;
            return false;
        }
    }

    getStats() {
        return {
            enviados: this.sentCount,
            fallidos: this.failCount,
            total: this.sentCount + this.failCount,
            tasaExito: this.sentCount + this.failCount > 0
                ? ((this.sentCount / (this.sentCount + this.failCount)) * 100).toFixed(2)
                : 0
        };
    }
}

class MockSupabaseService {
    constructor() {
        this.savedGames = [];
        this.processedCount = 0;
    }

    async gameExists(gameId) {
        return this.savedGames.includes(gameId);
    }

    async saveGame(gameData, players) {
        this.savedGames.push(gameData.gameUniqueId);
        this.processedCount++;
        console.log(`   💾 Guardado en DB: ${gameData.gameUniqueId}`);
        return true;
    }

    getProcessedCount() {
        return this.processedCount;
    }

    getStats() {
        return {
            juegosGuardados: this.savedGames.length,
            jugadoresProcesados: this.savedGames.length * 8, // Asumiendo 8 jugadores por juego
            duplicadosEvitados: this.processedCount - this.savedGames.length
        };
    }
}

class MockRendererService {
    constructor() {
        this.renderedCount = 0;
    }

    async generatePNG(gameData, players, pngPath) {
        this.renderedCount++;
        // Simular creación de archivo (sin realmente crearlo)
        console.log(`   🎨 PNG generado: match_${gameData.gameUniqueId}.png`);
        return true;
    }

    getStats() {
        return {
            imagenes: this.renderedCount
        };
    }
}

// Generar datos de prueba
function generarDatosPrueba(index) {
    const mapas = ['Guardian', 'The Pit', 'Narrows', 'Construct', 'Heretic'];
    const gamertags = ['Player1', 'Player2', 'Player3', 'Player4', 'Player5', 'Player6', 'Player7', 'Player8'];

    const gameData = {
        gameUniqueId: `test-game-${Date.now()}-${index}`,
        mapName: mapas[Math.floor(Math.random() * mapas.length)],
        gameMode: 'Team Slayer',
        endDate: new Date().toISOString(),
        duration: Math.floor(Math.random() * 600) + 300,
        isMatchmaking: false
    };

    const players = gamertags.map((gt, i) => ({
        gamertag: gt,
        teamId: i < 4 ? 0 : 1,
        score: Math.floor(Math.random() * 50),
        kills: Math.floor(Math.random() * 25),
        deaths: Math.floor(Math.random() * 20),
        assists: Math.floor(Math.random() * 15)
    }));

    return { gameData, players };
}

// Simular procesamiento de reportes
async function procesarReporte(discord, supabase, renderer, gameData, players) {
    const gameId = gameData.gameUniqueId;
    console.log(`\n📥 Procesando: ${gameId} (${gameData.mapName})`);

    // 1. Verificar duplicados
    const exists = await supabase.gameExists(gameId);
    if (exists) {
        console.log(`   ⏭️  Juego ${gameId} ya procesado, saltando`);
        return { status: 'duplicate', gameId };
    }

    // 2. Generar PNG
    const pngPath = `/tmp/match_${gameId}.png`;
    await renderer.generatePNG(gameData, players, pngPath);

    // 3. Enviar a Discord
    const dsResult = await discord.sendImage(pngPath, gameData, players);
    console.log(`   ${dsResult ? '✅' : '❌'} Discord: ${dsResult ? 'Enviado' : 'Fallido'}`);

    // 4. Guardar en Supabase
    await supabase.saveGame(gameData, players);

    console.log(`   ✅ Procesado completamente`);

    return {
        status: 'processed',
        gameId,
        discordSent: dsResult
    };
}

// Ejecutar pruebas
async function ejecutarPruebas() {
    console.log('╔══════════════════════════════════════════════════════════╗');
    console.log('║        TEST DE ESTADÍSTICAS DE ENVÍOS                    ║');
    console.log('║          CarnageReporter - Stats Test                    ║');
    console.log('╚══════════════════════════════════════════════════════════╝\n');

    // Inicializar servicios mock
    const discord = new MockDiscordService();
    const supabase = new MockSupabaseService();
    const renderer = new MockRendererService();

    const numPruebas = 10;
    const resultados = [];

    console.log(`🧪 Ejecutando ${numPruebas} pruebas de envío...\n`);

    // Procesar múltiples reportes
    for (let i = 0; i < numPruebas; i++) {
        const { gameData, players } = generarDatosPrueba(i);
        const resultado = await procesarReporte(discord, supabase, renderer, gameData, players);
        resultados.push(resultado);

        // Pequeña pausa para simular tiempo real
        await new Promise(resolve => setTimeout(resolve, 100));
    }

    // Probar duplicado
    console.log('\n🔄 Probando detección de duplicados...');
    const { gameData: dupData, players: dupPlayers } = generarDatosPrueba(0);
    dupData.gameUniqueId = resultados[0].gameId;
    const dupResult = await procesarReporte(discord, supabase, renderer, dupData, dupPlayers);

    // Mostrar estadísticas finales
    console.log('\n\n╔══════════════════════════════════════════════════════════╗');
    console.log('║              ESTADÍSTICAS DE ENVÍOS                      ║');
    console.log('╚══════════════════════════════════════════════════════════╝\n');

    const discordStats = discord.getStats();
    const supabaseStats = supabase.getStats();
    const rendererStats = renderer.getStats();

    console.log('📤 DISCORD:');
    console.log(`   ✅ Enviados exitosamente: ${discordStats.enviados}`);
    console.log(`   ❌ Fallidos: ${discordStats.fallidos}`);
    console.log(`   📊 Total intentos: ${discordStats.total}`);
    console.log(`   📈 Tasa de éxito: ${discordStats.tasaExito}%`);

    console.log('\n💾 SUPABASE:');
    console.log(`   📁 Juegos guardados: ${supabaseStats.juegosGuardados}`);
    console.log(`   👥 Jugadores procesados: ${supabaseStats.jugadoresProcesados}`);

    console.log('\n🎨 RENDERER:');
    console.log(`   🖼️  Imágenes generadas: ${rendererStats.imagenes}`);

    console.log('\n📋 RESUMEN GENERAL:');
    console.log(`   🎮 Total de reportes procesados: ${resultados.filter(r => r.status === 'processed').length}`);
    console.log(`   ⏭️  Duplicados detectados: ${resultados.filter(r => r.status === 'duplicate').length + (dupResult.status === 'duplicate' ? 1 : 0)}`);
    console.log(`   ✅ Envíos exitosos a Discord: ${discordStats.enviados}`);
    console.log(`   ❌ Envíos fallidos a Discord: ${discordStats.fallidos}`);

    // Validaciones
    console.log('\n\n🔍 VALIDACIONES:');
    const tests = [
        {
            nombre: 'Todos los reportes fueron procesados',
            check: resultados.every(r => r.status === 'processed' || r.status === 'duplicate'),
            esperado: true
        },
        {
            nombre: 'Se generó una imagen por cada reporte',
            check: rendererStats.imagenes === numPruebas,
            esperado: true
        },
        {
            nombre: 'Se guardaron todos los juegos en DB',
            check: supabaseStats.juegosGuardados === numPruebas,
            esperado: true
        },
        {
            nombre: 'Detección de duplicados funciona',
            check: dupResult.status === 'duplicate',
            esperado: true
        },
        {
            nombre: 'Tasa de éxito de Discord >= 70%',
            check: parseFloat(discordStats.tasaExito) >= 70,
            esperado: true
        }
    ];

    let testsPasados = 0;
    tests.forEach(test => {
        const pasado = test.check === test.esperado;
        if (pasado) testsPasados++;
        console.log(`   ${pasado ? '✅' : '❌'} ${test.nombre}: ${pasado ? 'PASADO' : 'FALLIDO'}`);
    });

    console.log(`\n\n🏆 RESULTADO FINAL: ${testsPasados}/${tests.length} tests pasados`);
    console.log(testsPasados === tests.length ? '   ✅ TODOS LOS TESTS PASARON\n' : '   ❌ ALGUNOS TESTS FALLARON\n');

    return testsPasados === tests.length;
}

// Ejecutar
ejecutarPruebas()
    .then(success => {
        process.exit(success ? 0 : 1);
    })
    .catch(error => {
        console.error('❌ Error ejecutando pruebas:', error);
        process.exit(1);
    });
