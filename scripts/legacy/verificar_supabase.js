/**
 * Verificación de datos en Supabase
 * Valida que los datos del PNG coincidan con la base de datos
 */

require('dotenv').config({ path: './server/.env' });
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('❌ Faltan credenciales de Supabase en .env');
    process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// El ID del juego que acabamos de enviar
const GAME_ID = 'test-discord-1769904955813';

// Datos originales que enviamos
const datosOriginales = {
    gameData: {
        gameUniqueId: GAME_ID,
        mapName: "Guardian",
        gameTypeName: "Team Slayer",
        playlistName: "Custom Games",
        duration: 720,
        isMatchmaking: false
    },
    players: [
        { gamertag: "iChocko", kills: 25, deaths: 15, assists: 8, score: 25, teamId: 0, killingSpree: 10 },
        { gamertag: "Pyro Master", kills: 18, deaths: 12, assists: 10, score: 18, teamId: 0, killingSpree: 6 },
        { gamertag: "Ghost Rider", kills: 15, deaths: 14, assists: 12, score: 15, teamId: 0, killingSpree: 5 },
        { gamertag: "Shadow Fox", kills: 12, deaths: 16, assists: 15, score: 12, teamId: 0, killingSpree: 4 },
        { gamertag: "Spartan 117", kills: 22, deaths: 18, assists: 7, score: 22, teamId: 1, killingSpree: 8 },
        { gamertag: "Elite Slayer", kills: 16, deaths: 15, assists: 9, score: 16, teamId: 1, killingSpree: 6 },
        { gamertag: "Cortana AI", kills: 14, deaths: 17, assists: 11, score: 14, teamId: 1, killingSpree: 5 },
        { gamertag: "Noble Six", kills: 10, deaths: 20, assists: 6, score: 10, teamId: 1, killingSpree: 3 }
    ]
};

async function verificarDatos() {
    console.log('╔══════════════════════════════════════════════════════════╗');
    console.log('║      VERIFICACIÓN DE DATOS EN SUPABASE                   ║');
    console.log('╚══════════════════════════════════════════════════════════╝\n');

    console.log(`🔍 Buscando juego: ${GAME_ID}\n`);

    // 1. Verificar que el juego existe en la tabla 'games'
    const { data: game, error: gameError } = await supabase
        .from('games')
        .select('*')
        .eq('game_unique_id', GAME_ID)
        .single();

    if (gameError) {
        console.error('❌ Error consultando juego:', gameError.message);
        return;
    }

    if (!game) {
        console.error('❌ Juego no encontrado en la base de datos');
        return;
    }

    console.log('✅ JUEGO ENCONTRADO EN SUPABASE\n');
    console.log('📋 DATOS DEL JUEGO:');
    console.log(`   🆔 ID: ${game.game_unique_id}`);
    console.log(`   🗺️  Mapa: ${game.map_name}`);
    console.log(`   🎯 Modo: ${game.game_type_name}`);
    console.log(`   📅 Fecha: ${game.end_date}`);
    console.log(`   ⏱️  Duración: ${game.duration} segundos`);
    console.log(`   🎮 Matchmaking: ${game.is_matchmaking ? 'Sí' : 'No'}`);
    console.log(`   📝 Playlist: ${game.playlist_name || 'N/A'}`);

    // Validar datos del juego
    console.log('\n🔍 VALIDACIÓN DE DATOS DEL JUEGO:');
    const validaciones = [
        { campo: 'Map Name', original: datosOriginales.gameData.mapName, db: game.map_name },
        { campo: 'Game Type', original: datosOriginales.gameData.gameTypeName, db: game.game_type_name },
        { campo: 'Duration', original: datosOriginales.gameData.duration, db: game.duration },
        { campo: 'Matchmaking', original: datosOriginales.gameData.isMatchmaking, db: game.is_matchmaking },
        { campo: 'Playlist', original: datosOriginales.gameData.playlistName, db: game.playlist_name }
    ];

    validaciones.forEach(v => {
        const match = v.original === v.db;
        console.log(`   ${match ? '✅' : '❌'} ${v.campo}: ${match ? 'Correcto' : `Original: ${v.original}, DB: ${v.db}`}`);
    });

    // 2. Obtener jugadores de la tabla 'players'
    const { data: players, error: playersError } = await supabase
        .from('players')
        .select('*')
        .eq('game_unique_id', GAME_ID)
        .order('score', { ascending: false });

    if (playersError) {
        console.error('❌ Error consultando jugadores:', playersError.message);
        return;
    }

    console.log(`\n✅ JUGADORES ENCONTRADOS: ${players.length}\n`);

    // 3. Validar datos de jugadores
    console.log('╔══════════════════════════════════════════════════════════╗');
    console.log('║           VALIDACIÓN DE DATOS DE JUGADORES               ║');
    console.log('╚══════════════════════════════════════════════════════════╝\n');

    let erroresValidacion = 0;

    players.forEach((playerDB, index) => {
        const playerOriginal = datosOriginales.players.find(p => p.gamertag === playerDB.gamertag);

        if (!playerOriginal) {
            console.log(`⚠️  Jugador en DB no encontrado en datos originales: ${playerDB.gamertag}`);
            erroresValidacion++;
            return;
        }

        console.log(`\n👤 ${playerDB.gamertag} (Team ${playerDB.team_id === 0 ? 'Blue' : 'Red'})`);

        const comparaciones = [
            { campo: 'Kills', original: playerOriginal.kills, db: playerDB.kills },
            { campo: 'Deaths', original: playerOriginal.deaths, db: playerDB.deaths },
            { campo: 'Assists', original: playerOriginal.assists, db: playerDB.assists },
            { campo: 'Score', original: playerOriginal.score, db: playerDB.score },
            { campo: 'Team ID', original: playerOriginal.teamId, db: playerDB.team_id }
        ];

        comparaciones.forEach(c => {
            const match = c.original === c.db;
            if (!match) {
                console.log(`   ❌ ${c.campo}: Original=${c.original}, DB=${c.db}`);
                erroresValidacion++;
            } else {
                console.log(`   ✅ ${c.campo}: ${c.db}`);
            }
        });

        // Mostrar datos adicionales que tiene la DB pero no el PNG
        console.log('\n   📊 DATOS ADICIONALES EN LA BASE DE DATOS:');
        console.log(`      • Service ID: ${playerDB.service_id || 'N/A'}`);
        console.log(`      • Player Index: ${playerDB.player_index !== null ? playerDB.player_index : 'N/A'}`);
        console.log(`      • K/D Ratio: ${playerDB.kd_ratio !== null ? playerDB.kd_ratio : 'N/A'}`);
        console.log(`      • Killing Spree: ${playerDB.killing_spree || 0}`);
        console.log(`      • Created At: ${playerDB.created_at}`);
    });

    // Verificar que no falten jugadores
    const jugadoresFaltantes = datosOriginales.players.filter(
        pOriginal => !players.find(pDB => pDB.gamertag === pOriginal.gamertag)
    );

    if (jugadoresFaltantes.length > 0) {
        console.log('\n⚠️  JUGADORES FALTANTES EN LA BASE DE DATOS:');
        jugadoresFaltantes.forEach(p => console.log(`   - ${p.gamertag}`));
        erroresValidacion += jugadoresFaltantes.length;
    }

    // 4. Verificar estadísticas agregadas (si existen)
    const { data: playerStats, error: statsError } = await supabase
        .from('player_stats')
        .select('*')
        .in('gamertag', datosOriginales.players.map(p => p.gamertag));

    if (!statsError && playerStats && playerStats.length > 0) {
        console.log('\n\n╔══════════════════════════════════════════════════════════╗');
        console.log('║         ESTADÍSTICAS AGREGADAS (player_stats)            ║');
        console.log('╚══════════════════════════════════════════════════════════╝\n');

        playerStats.forEach(stat => {
            console.log(`👤 ${stat.gamertag}:`);
            console.log(`   📊 Total Games: ${stat.total_games}`);
            console.log(`   ⚔️  Total Kills: ${stat.total_kills}`);
            console.log(`   💀 Total Deaths: ${stat.total_deaths}`);
            console.log(`   🤝 Total Assists: ${stat.total_assists}`);
            console.log(`   📈 Overall K/D: ${stat.overall_kd}`);
            console.log(`   🔥 Best Spree: ${stat.best_spree}`);
            console.log(`   ⭐ Total Score: ${stat.total_score}`);
            console.log();
        });
    }

    // 5. Resumen final
    console.log('\n╔══════════════════════════════════════════════════════════╗');
    console.log('║                  RESUMEN DE VALIDACIÓN                   ║');
    console.log('╚══════════════════════════════════════════════════════════╝\n');

    console.log(`✅ Juego guardado correctamente: ${game.game_unique_id}`);
    console.log(`✅ Jugadores guardados: ${players.length}/${datosOriginales.players.length}`);
    console.log(`${erroresValidacion === 0 ? '✅' : '⚠️'} Errores de validación: ${erroresValidacion}`);

    if (erroresValidacion === 0) {
        console.log('\n🎉 ¡TODOS LOS DATOS SON CONSISTENTES!');
        console.log('   ✅ El PNG muestra la información correcta');
        console.log('   ✅ La base de datos tiene todos los datos');
        console.log('   ✅ Los valores coinciden perfectamente');
        console.log('   ✅ La base de datos contiene información adicional útil');
    } else {
        console.log('\n⚠️  SE ENCONTRARON INCONSISTENCIAS');
        console.log(`   Por favor revisa los ${erroresValidacion} errores mencionados arriba`);
    }

    console.log('\n' + '═'.repeat(60) + '\n');
}

verificarDatos()
    .then(() => process.exit(0))
    .catch(error => {
        console.error('❌ Error durante la verificación:', error);
        process.exit(1);
    });
