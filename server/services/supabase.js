/**
 * Supabase Service
 * Base de datos y deduplicación de partidas
 */

const { createClient } = require('@supabase/supabase-js');

class SupabaseService {
    constructor() {
        this.supabaseUrl = process.env.SUPABASE_URL;
        this.supabaseKey = process.env.SUPABASE_KEY;
        this.client = null;
        this.processedCount = 0;

        if (this.supabaseUrl && this.supabaseKey) {
            this.client = createClient(this.supabaseUrl, this.supabaseKey);
            console.log('✅ Supabase inicializado');
        } else {
            console.log('⚠️  Supabase no configurado');
        }
    }

    /**
     * Verifica si un juego ya existe en la base de datos
     * @param {string} gameUniqueId - ID único del juego
     * @returns {boolean} - true si existe, false si no
     */
    async gameExists(gameUniqueId) {
        if (!this.client) return false;

        try {
            const { data, error } = await this.client
                .from('games')
                .select('game_unique_id')
                .eq('game_unique_id', gameUniqueId)
                .single();

            if (error && error.code !== 'PGRST116') {
                // PGRST116 = no rows found (es esperado)
                console.error('Error verificando duplicado:', error.message);
            }

            return !!data;
        } catch (error) {
            console.error('Error en gameExists:', error.message);
            return false;
        }
    }

    /**
     * Guarda un juego y sus jugadores en Supabase
     * @param {object} gameData - Datos del juego
     * @param {array} players - Lista de jugadores
     */
    async saveGame(gameData, players) {
        if (!this.client) {
            console.log('⚠️  Supabase no disponible, saltando guardado');
            return false;
        }

        try {
            // 1. Insertar el juego (upsert para evitar duplicados)
            const { error: gameError } = await this.client
                .from('games')
                .upsert({
                    game_unique_id: gameData.gameUniqueId,
                    game_enum: gameData.gameEnum,
                    is_matchmaking: gameData.isMatchmaking,
                    is_teams_enabled: gameData.isTeamsEnabled,
                    hopper_name: gameData.hopperName,
                    game_type_name: gameData.gameTypeName,
                    map_name: gameData.mapName,
                    timestamp: new Date(gameData.timestamp).toISOString(),
                    // Guardar el tiempo local de CDMX desplazando el UTC para que se vea la hora nominal correcta en la DB
                    timestamp_cdmx: new Date(new Date(gameData.timestamp).getTime() - (6 * 60 * 60 * 1000)).toISOString()
                }, { onConflict: 'game_unique_id' });

            if (gameError) {
                throw new Error(`Error guardando juego: ${gameError.message}`);
            }

            // 2. Insertar jugadores
            for (const p of players) {
                const { error: playerError } = await this.client
                    .from('players')
                    .upsert({
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
                    }, {
                        onConflict: 'game_unique_id,xbox_user_id',
                        ignoreDuplicates: true
                    });

                if (playerError && !playerError.message.includes('duplicate')) {
                    console.error(`⚠️  Error inserting player ${p.gamertag}:`, playerError.message);
                }
            }

            this.processedCount++;
            console.log(`✅ Juego ${gameData.gameUniqueId} guardado en Supabase`);
            return true;

        } catch (error) {
            console.error('❌ Error guardando en Supabase:', error.message);
            return false;
        }
    }

    /**
     * Obtiene estadísticas de un jugador
     * @param {string} gamertag - Nombre del jugador
     */
    async getPlayerStats(gamertag) {
        if (!this.client) return null;

        try {
            const { data, error } = await this.client
                .from('players')
                .select('*')
                .ilike('gamertag', gamertag);

            if (error) throw error;

            // Calcular totales
            const stats = {
                gamertag,
                totalGames: data.length,
                totalKills: data.reduce((sum, p) => sum + p.kills, 0),
                totalDeaths: data.reduce((sum, p) => sum + p.deaths, 0),
                totalAssists: data.reduce((sum, p) => sum + p.assists, 0),
                totalScore: data.reduce((sum, p) => sum + p.score, 0),
                avgKD: 0
            };

            if (stats.totalDeaths > 0) {
                stats.avgKD = (stats.totalKills / stats.totalDeaths).toFixed(2);
            }

            return stats;
        } catch (error) {
            console.error('Error obteniendo stats:', error.message);
            return null;
        }
    }

    /**
     * Obtiene los últimos N juegos
     * @param {number} limit - Número de juegos a obtener
     */
    async getRecentGames(limit = 10) {
        if (!this.client) return [];

        try {
            const { data, error } = await this.client
                .from('games')
                .select('*')
                .order('timestamp', { ascending: false })
                .limit(limit);

            if (error) throw error;
            return data;
        } catch (error) {
            console.error('Error obteniendo juegos recientes:', error.message);
            return [];
        }
    }

    getProcessedCount() {
        return this.processedCount;
    }
}

module.exports = SupabaseService;
