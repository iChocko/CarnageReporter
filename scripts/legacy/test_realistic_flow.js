/**
 * Test de Flujo Realista
 * Simula 2 partidas consecutivas como si se jugaran en MCC
 */

const fs = require('fs');
const path = require('path');
const MCCClient = require('./client/simulator');
const { generateMatch } = require('./client/match_generator');

// Configuración
const TEMP_DIR = path.join(__dirname, 'client/temp');
const MATCH_DELAY = 8000; // 8 segundos entre partidas

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Simula que Halo 3 MCC genera un archivo de carnage report
 */
function simulateMCCFileGeneration(matchData) {
    const filePath = path.join(TEMP_DIR, matchData.filename.replace('.xml', '.json'));
    fs.writeFileSync(filePath, JSON.stringify(matchData, null, 2));
    console.log(`\n🎮 MCC ha generado un nuevo carnage report:`);
    console.log(`   📁 ${matchData.filename}`);
    return filePath;
}

async function runRealisticTest() {
    console.log('╔══════════════════════════════════════════════════════════╗');
    console.log('║          TEST DE FLUJO REALISTA - 2 PARTIDAS             ║');
    console.log('║     Simulación de Cliente Externo con File Monitoring    ║');
    console.log('╚══════════════════════════════════════════════════════════╝\n');

    // Inicializar cliente
    const client = new MCCClient({
        tempDir: TEMP_DIR,
        serverHost: 'localhost',
        serverPort: 3000,
        pollInterval: 1500 // Verifica cada 1.5 segundos
    });

    await client.init();

    // Iniciar monitoreo
    client.startMonitoring();

    console.log('═'.repeat(60));
    console.log('           SIMULACIÓN DE SESIÓN DE JUEGO');
    console.log('═'.repeat(60));

    // PARTIDA 1
    console.log('\n\n🎯 PARTIDA 1: Iniciando...');
    await sleep(2000); // Simula tiempo de carga del juego

    const match1 = generateMatch(1, true);
    console.log('   🏁 Partida finalizada, generando carnage report...');
    await sleep(1000);

    simulateMCCFileGeneration(match1);
    console.log('   ⏳ Esperando que el cliente detecte el archivo...');

    // Esperar a que el cliente procese
    await sleep(MATCH_DELAY);

    // PARTIDA 2
    console.log('\n\n🎯 PARTIDA 2: Iniciando...');
    await sleep(2000); // Simula tiempo entre partidas

    const match2 = generateMatch(2, true);
    console.log('   🏁 Partida finalizada, generando carnage report...');
    await sleep(1000);

    simulateMCCFileGeneration(match2);
    console.log('   ⏳ Esperando que el cliente detecte el archivo...');

    // Esperar procesamiento final
    await sleep(MATCH_DELAY);

    // Detener monitoreo y mostrar stats
    client.stopMonitoring();
    client.showStats();

    // Verificar en Supabase
    console.log('═'.repeat(60));
    console.log('           VERIFICACIÓN EN SUPABASE');
    console.log('═'.repeat(60));

    await verificarSupabase(match1.gameData.gameUniqueId, match2.gameData.gameUniqueId);

    console.log('\n✅ Test completado!\n');
    console.log('📋 Próximos pasos:');
    console.log('   1. Verifica Discord para ver los 2 mensajes con imágenes');
    console.log('   2. Verifica Supabase para confirmar los datos');
    console.log('   3. Abre el dashboard para ver las stats actualizadas\n');

    process.exit(0);
}

/**
 * Verifica que los datos estén en Supabase
 */
async function verificarSupabase(gameId1, gameId2) {
    try {
        require('dotenv').config({ path: './server/.env' });
        const { createClient } = require('@supabase/supabase-js');

        const supabase = createClient(
            process.env.SUPABASE_URL,
            process.env.SUPABASE_KEY
        );

        console.log('\n🔍 Verificando partida 1...');
        const { data: game1, error: error1 } = await supabase
            .from('games')
            .select('*, players(*)')
            .eq('game_unique_id', gameId1)
            .single();

        if (error1) {
            console.log(`   ❌ Error: ${error1.message}`);
        } else if (game1) {
            console.log(`   ✅ Partida 1 encontrada:`);
            console.log(`      • Mapa: ${game1.map_name}`);
            console.log(`      • Modo: ${game1.game_type_name}`);
            console.log(`      • Duración: ${game1.duration}s`);
            console.log(`      • Playlist: ${game1.playlist_name}`);
        }

        console.log('\n🔍 Verificando partida 2...');
        const { data: game2, error: error2 } = await supabase
            .from('games')
            .select('*, players(*)')
            .eq('game_unique_id', gameId2)
            .single();

        if (error2) {
            console.log(`   ❌ Error: ${error2.message}`);
        } else if (game2) {
            console.log(`   ✅ Partida 2 encontrada:`);
            console.log(`      • Mapa: ${game2.map_name}`);
            console.log(`      • Modo: ${game2.game_type_name}`);
            console.log(`      • Duración: ${game2.duration}s`);
            console.log(`      • Playlist: ${game2.playlist_name}`);
        }

        // Contar total de jugadores
        const { count, error: countError } = await supabase
            .from('players')
            .select('*', { count: 'exact', head: true })
            .in('game_unique_id', [gameId1, gameId2]);

        if (!countError) {
            console.log(`\n   👥 Total de jugadores registrados: ${count}/16`);
        }

        console.log('\n   🎉 Verificación de Supabase completada!');

    } catch (error) {
        console.log('   ⚠️  Error durante verificación:', error.message);
    }
}

// Ejecutar test
runRealisticTest().catch(error => {
    console.error('\n❌ Error fatal:', error);
    process.exit(1);
});
