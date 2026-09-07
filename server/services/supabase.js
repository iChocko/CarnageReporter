/**
 * Supabase Service
 * Base de datos y deduplicación de partidas
 */

const { createClient } = require('@supabase/supabase-js');
const { logger } = require('../logger');

const log = logger.child({ mod: 'supabase' });

class SupabaseService {
    constructor() {
        this.supabaseUrl = process.env.SUPABASE_URL;
        this.supabaseKey = process.env.SUPABASE_KEY;
        this.client = null;
        this.processedCount = 0;

        if (this.supabaseUrl && this.supabaseKey) {
            this.client = createClient(this.supabaseUrl, this.supabaseKey);
            log.info('✅ Supabase inicializado');
        } else {
            log.warn('⚠️  Supabase no configurado');
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
                log.error({ err: error }, 'Error verificando duplicado');
            }

            return !!data;
        } catch (error) {
            log.error({ err: error }, 'Error en gameExists');
            return false;
        }
    }

    /**
     * Guarda un juego y sus jugadores en Supabase.
     *
     * Fase A0: cualquier error de Supabase (juego o jugadores) TRUENA
     * (throw) en vez de tragarse el error y devolver false. Antes, un fallo
     * a medio guardar dejaba una partida que /api/report contestaba como
     * "processed" sin haber quedado realmente persistida; ahora el error
     * sube hasta el try/catch del endpoint, que responde 500.
     *
     * @param {object} gameData - Datos del juego
     * @param {array} players - Lista de jugadores
     * @param {object} [meta] - { isVoided, voidReason, schemaVersion, clientVersion }
     * @throws {Error} si el upsert del juego o el de jugadores falla
     */
    async saveGame(gameData, players, meta = {}) {
        if (!this.client) {
            log.warn('⚠️  Supabase no disponible, saltando guardado');
            return false;
        }

        const { isVoided = false, voidReason = null, schemaVersion = 1, clientVersion = null,
                mapCode = null, format = null, installId = null, clientSentAt = null } = meta;

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
                timestamp_cdmx: new Date(new Date(gameData.timestamp).getTime() - (6 * 60 * 60 * 1000)).toISOString(),
                duration: gameData.duration || 0,
                playlist_name: gameData.playlistName || null,
                last_match_incomplete: gameData.lastMatchIncomplete === true,
                party_size: gameData.partySize ?? null,
                is_voided: isVoided,
                void_reason: voidReason,
                schema_version: schemaVersion,
                client_version: clientVersion,
                map_code: mapCode,
                format: format,
                // Fase B3: identidad de instalación y hora real del cliente al enviar
                reported_by_install: installId,
                client_sent_at: (clientSentAt && Number.isFinite(new Date(clientSentAt).getTime()))
                    ? new Date(clientSentAt).toISOString() : null
            }, { onConflict: 'game_unique_id' });

        if (gameError) {
            throw new Error(`Error guardando juego: ${gameError.message}`);
        }

        // 2. Insertar jugadores con índices y cálculos, en UN SOLO upsert en
        // lote (antes era un upsert por jugador). Agrupar por CUALQUIER
        // teamId presente (no solo 0/1): en FFA o partidas multi-equipo
        // antes se perdían los jugadores de otros equipos.
        const teams = new Map();
        for (const p of players) {
            const teamId = p.teamId ?? 0;
            if (!teams.has(teamId)) teams.set(teamId, []);
            teams.get(teamId).push(p);
        }

        const playersWithIndex = [];
        for (const teamPlayers of teams.values()) {
            teamPlayers
                .sort((a, b) => b.score - a.score)
                .forEach((p, idx) => playersWithIndex.push({ ...p, playerIndex: idx }));
        }

        if (playersWithIndex.length > 0) {
            const rows = playersWithIndex.map(p => {
                // Calcular K/D ratio
                const kdRatio = p.deaths > 0 ? (p.kills / p.deaths) : p.kills;
                return {
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
                    most_kills_in_a_row: p.killingSpree || p.mostKillsInARow || 0,
                    seconds_played: p.secondsPlayed || 0,
                    seconds_alive: p.secondsAlive || 0,
                    completed_game: (p.completedGame === 0 || p.completedGame === 1) ? p.completedGame : null,
                    kills_weapon: p.killsWeapon || 0,
                    kills_grenade: p.killsGrenade || 0,
                    kills_melee: p.killsMelee || 0,
                    kills_other: p.killsOther || 0,
                    is_guest: p.isGuest === true,
                    medals: Array.isArray(p.medals) && p.medals.length > 0 ? p.medals : null,
                    // Campos calculados
                    player_index: p.playerIndex,
                    kd_ratio: Math.round(kdRatio * 100) / 100 // Redondear a 2 decimales
                };
            });

            const { error: playersError } = await this.client
                .from('players')
                .upsert(rows, {
                    onConflict: 'game_unique_id,xbox_user_id',
                    ignoreDuplicates: true
                });

            if (playersError) {
                throw new Error(`Error guardando jugadores: ${playersError.message}`);
            }
        }

        this.processedCount++;
        log.info(`✅ Juego ${gameData.gameUniqueId} guardado en Supabase${isVoided ? ` (ANULADO: ${voidReason})` : ''}`);
        return true;
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
            log.error({ err: error }, 'Error obteniendo stats');
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
            log.error({ err: error }, 'Error obteniendo juegos recientes');
            return [];
        }
    }

    /**
     * Helper interno: partidas válidas (no anuladas) de un formato, con jugadores
     * anidados, más reciente primero. La columna `format` es el filtro (2v2 incluye
     * solo customs; 4v4 incluye customs y matchmaking).
     * @param {object} opts { format?: '2v2'|'4v4', limit?: number }
     */
    async _gamesWithPlayers({ format, limit } = {}) {
        if (!this.client) return [];

        let query = this.client
            .from('games')
            .select('game_unique_id, map_name, game_type_name, timestamp, duration, is_teams_enabled, format')
            .eq('is_voided', false)
            .order('timestamp', { ascending: false });
        if (format) query = query.eq('format', format);
        if (limit) query = query.limit(limit);

        const { data: games, error: gError } = await query;
        if (gError) throw new Error(gError.message);
        if (!games || games.length === 0) return [];

        const ids = games.map(g => g.game_unique_id);
        const players = [];
        for (let i = 0; i < ids.length; i += 200) {
            const { data, error } = await this.client
                .from('players')
                .select('game_unique_id, gamertag, team_id, score, kills, deaths, assists, most_kills_in_a_row')
                .in('game_unique_id', ids.slice(i, i + 200));
            if (error) throw new Error(error.message);
            players.push(...(data || []));
        }

        const byGame = new Map();
        for (const p of players) {
            if (!byGame.has(p.game_unique_id)) byGame.set(p.game_unique_id, []);
            byGame.get(p.game_unique_id).push(p);
        }

        return games.map(g => ({ ...g, players: byGame.get(g.game_unique_id) || [] }));
    }

    /** TODAS las partidas válidas de un formato (récords, H2H, perfiles, leaderboard). */
    async getAllValidGamesWithPlayers(format) {
        return this._gamesWithPlayers({ format });
    }

    /** Últimas N partidas válidas de un formato (recientes y comando !partidas). */
    async getRecentGamesWithPlayers(limit = 10, format) {
        return this._gamesWithPlayers({ format, limit });
    }

    /**
     * Busca partidas cuyo ID empiece con el prefijo dado (ID corto de la imagen).
     * @param {string} prefix - Prefijo del game_unique_id (>= 6 caracteres)
     * @returns {array} - Lista de { game_unique_id, map_name, timestamp, is_voided }
     */
    async findGamesByIdPrefix(prefix) {
        if (!this.client) return [];

        const { data, error } = await this.client
            .from('games')
            .select('game_unique_id, map_name, game_type_name, timestamp, is_voided')
            .like('game_unique_id', `${prefix}%`)
            .limit(10);

        if (error) throw new Error(`Error buscando por prefijo: ${error.message}`);
        return data || [];
    }

    /**
     * Elimina una partida y sus jugadores.
     * @param {string} gameUniqueId - ID completo de la partida
     */
    async deleteGame(gameUniqueId) {
        if (!this.client) throw new Error('Supabase no disponible');

        // Borrar jugadores primero (el FK tiene ON DELETE CASCADE, pero
        // el orden explícito es defensa extra ante esquemas viejos)
        const { error: pError } = await this.client
            .from('players')
            .delete()
            .eq('game_unique_id', gameUniqueId);
        if (pError) throw new Error(`Error borrando jugadores: ${pError.message}`);

        const { error: gError } = await this.client
            .from('games')
            .delete()
            .eq('game_unique_id', gameUniqueId);
        if (gError) throw new Error(`Error borrando juego: ${gError.message}`);

        return true;
    }

    /**
     * Marca o desmarca una partida como anulada.
     * @param {string} gameUniqueId - ID completo de la partida
     * @param {boolean} voided - true para anular, false para restaurar
     * @param {string|null} reason - Motivo (se limpia al restaurar)
     */
    async setVoided(gameUniqueId, voided, reason = null) {
        if (!this.client) throw new Error('Supabase no disponible');

        const { error } = await this.client
            .from('games')
            .update({ is_voided: voided, void_reason: voided ? (reason || 'manual') : null })
            .eq('game_unique_id', gameUniqueId);

        if (error) throw new Error(`Error actualizando is_voided: ${error.message}`);
        return true;
    }

    getProcessedCount() {
        return this.processedCount;
    }

    /**
     * Sube (upsert) una copia de un archivo de estado local (roster, W.O.,
     * anuladas, ajustes, reset de rondas, corte de saldos) como segunda
     * copia fuera del host, además del .tar.gz local que arma jobs/backup.js.
     * Tabla `state_backups` — ver bloque "migración A0" en supabase_schema.sql
     * (se aplica a mano en el SQL editor, esta fase no la corre).
     * @param {string} name - nombre del archivo (p.ej. "whatsapp_roster.json")
     * @param {string} takenAt - ISO timestamp del backup
     * @param {object} content - contenido ya parseado del JSON
     * @returns {Promise<boolean>}
     */
    async saveStateBackup(name, takenAt, content) {
        if (!this.client) {
            log.warn(`⚠️  Supabase no disponible, backup de estado omitido (${name})`);
            return false;
        }

        try {
            const { error } = await this.client
                .from('state_backups')
                .upsert({ name, taken_at: takenAt, content }, { onConflict: 'name,taken_at' });

            if (error) {
                log.error({ err: error }, `❌ Error subiendo backup de ${name}`);
                return false;
            }
            return true;
        } catch (error) {
            log.error({ err: error }, `❌ Error subiendo backup de ${name}`);
            return false;
        }
    }
}

module.exports = SupabaseService;
