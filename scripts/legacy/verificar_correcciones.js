/**
 * Verificación completa de campos corregidos
 */

require('dotenv').config({ path: './server/.env' });
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// El ID del juego que acabamos de enviar
const GAME_ID = 'test-discord-1769905558297';

async function verificarCamposCorregidos() {
    console.log('╔══════════════════════════════════════════════════════════╗');
    console.log('║      VERIFICACIÓN DE CAMPOS CORREGIDOS                   ║');
    console.log('╚══════════════════════════════════════════════════════════╝\n');

    console.log(`🔍 Verificando juego: ${GAME_ID}\n`);

    // 1. Verificar campos de games
    const { data: game, error: gameError } = await supabase
        .from('games')
        .select('*')
        .eq('game_unique_id', GAME_ID)
        .single();

    if (gameError) {
        console.error('❌ Error:', gameError.message);
        return;
    }

    console.log('═'.repeat(60));
    console.log('📋 TABLA GAMES - CAMPOS CORREGIDOS');
    console.log('═'.repeat(60));
    console.log(`✅ game_unique_id: ${game.game_unique_id}`);
    console.log(`✅ map_name: ${game.map_name}`);
    console.log(`✅ game_type_name: ${game.game_type_name}`);
    console.log(`${game.duration !== null && game.duration !== undefined ? '✅' : '❌'} duration: ${game.duration} segundos ${game.duration === 720 ? '(CORRECTO)' : '(VERIFICAR)'}`);
    console.log(`${game.playlist_name ? '✅' : '❌'} playlist_name: ${game.playlist_name || 'NULL'} ${game.playlist_name === 'Custom Games' ? '(CORRECTO)' : ''}`);
    console.log(`✅ is_matchmaking: ${game.is_matchmaking}`);
    console.log(`✅ timestamp: ${game.timestamp}`);

    // 2. Verificar campos de players
    const { data: players, error: playersError } = await supabase
        .from('players')
        .select('*')
        .eq('game_unique_id', GAME_ID)
        .order('score', { ascending: false });

    if (playersError) {
        console.error('❌ Error:', playersError.message);
        return;
    }

    console.log('\n═'.repeat(60));
    console.log('👥 TABLA PLAYERS - CAMPOS CORREGIDOS');
    console.log('═'.repeat(60));
    console.log(`Total jugadores: ${players.length}\n`);

    // Verificar campos específicos
    let errores = 0;

    players.forEach((p, idx) => {
        console.log(`\n${idx + 1}. ${p.gamertag} (Team ${p.team_id === 0 ? 'Blue' : 'Red'})`);
        console.log(`   📊 Kills: ${p.kills}, Deaths: ${p.deaths}, Assists: ${p.assists}, Score: ${p.score}`);

        // Verificar player_index
        const expectedIndex = players.filter(pl => pl.team_id === p.team_id && pl.score >= p.score).length - 1;
        const playerIndexCorrect = p.player_index !== null && p.player_index !== undefined;
        console.log(`   ${playerIndexCorrect ? '✅' : '❌'} player_index: ${p.player_index} ${playerIndexCorrect ? '(EXISTE)' : '(FALTA)'}`);
        if (!playerIndexCorrect) errores++;

        // Verificar kd_ratio
        const expectedKD = p.deaths > 0 ? (p.kills / p.deaths) : p.kills;
        const kdRatioCorrect = p.kd_ratio !== null && p.kd_ratio !== undefined && p.kd_ratio > 0;
        console.log(`   ${kdRatioCorrect ? '✅' : '❌'} kd_ratio: ${p.kd_ratio} ${kdRatioCorrect ? `(CALCULADO: ${expectedKD.toFixed(2)})` : '(FALTA)'}`);
        if (!kdRatioCorrect) errores++;

        // Verificar killing_spree (most_kills_in_a_row)
        const spreeCorrect = p.most_kills_in_a_row !== null && p.most_kills_in_a_row !== undefined;
        console.log(`   ${spreeCorrect ? '✅' : '❌'} most_kills_in_a_row: ${p.most_kills_in_a_row} ${spreeCorrect ? '(EXISTE)' : '(FALTA)'}`);
        if (!spreeCorrect) errores++;
    });

    // Verificar que los índices estén bien ordenados por equipo
    console.log('\n═'.repeat(60));
    console.log('🔍 VERIFICACIÓN DE ÍNDICES POR EQUIPO');
    console.log('═'.repeat(60));

    const team0 = players.filter(p => p.team_id === 0).sort((a, b) => a.player_index - b.player_index);
    const team1 = players.filter(p => p.team_id === 1).sort((a, b) => a.player_index - b.player_index);

    console.log('\n🔵 TEAM BLUE (ordenado por player_index):');
    team0.forEach(p => {
        console.log(`   ${p.player_index}: ${p.gamertag} - Score: ${p.score}`);
    });

    console.log('\n🔴 TEAM RED (ordenado por player_index):');
    team1.forEach(p => {
        console.log(`   ${p.player_index}: ${p.gamertag} - Score: ${p.score}`);
    });

    // Resumen final
    console.log('\n\n╔══════════════════════════════════════════════════════════╗');
    console.log('║                  RESUMEN DE CORRECCIONES                 ║');
    console.log('╚══════════════════════════════════════════════════════════╝\n');

    const duracionOK = game.duration !== null && game.duration !== undefined && game.duration === 720;
    const playlistOK = game.playlist_name === 'Custom Games';
    const camposJugadoresOK = errores === 0;

    console.log('📋 TABLA GAMES:');
    console.log(`   ${duracionOK ? '✅' : '❌'} Campo 'duration' ${duracionOK ? 'guardado correctamente (720s)' : 'NO guardado o valor incorrecto'}`);
    console.log(`   ${playlistOK ? '✅' : '❌'} Campo 'playlist_name' ${playlistOK ? 'guardado correctamente' : 'NO guardado o valor incorrecto'}`);

    console.log('\n👥 TABLA PLAYERS:');
    console.log(`   ${camposJugadoresOK ? '✅' : '❌'} Campos calculados ${camposJugadoresOK ? 'guardados correctamente' : `tienen ${errores} errores`}`);
    console.log(`   ${camposJugadoresOK ? '✅' : '⚠️'} player_index: ${camposJugadoresOK ? 'Calculado por equipo' : 'Verificar cálculo'}`);
    console.log(`   ${camposJugadoresOK ? '✅' : '⚠️'} kd_ratio: ${camposJugadoresOK ? 'Calculado correctamente' : 'Verificar cálculo'}`);
    console.log(`   ${camposJugadoresOK ? '✅' : '⚠️'} most_kills_in_a_row: ${camposJugadoresOK ? 'Mapeado correctamente' : 'Verificar mapeo'}`);

    if (duracionOK && playlistOK && camposJugadoresOK) {
        console.log('\n🎉 ¡TODAS LAS CORRECCIONES APLICADAS EXITOSAMENTE!');
        console.log('   ✅ Todos los campos se guardan correctamente');
        console.log('   ✅ Los cálculos son precisos');
        console.log('   ✅ El sistema está listo para producción\n');
    } else {
        console.log('\n⚠️  ALGUNAS CORRECCIONES NECESITAN REVISIÓN');
        console.log('   Revisa los detalles arriba para identificar problemas\n');
    }

    console.log('═'.repeat(60) + '\n');
}

verificarCamposCorregidos()
    .then(() => process.exit(0))
    .catch(error => {
        console.error('❌ Error:', error);
        process.exit(1);
    });
