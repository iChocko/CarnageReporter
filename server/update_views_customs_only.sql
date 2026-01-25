-- ============================================================
-- ACTUALIZACIÓN DE VISTAS - SOLO CUSTOMS (NO MATCHMAKING)
-- ============================================================
-- Ejecutar en Supabase SQL Editor para actualizar las vistas
-- ============================================================

-- Vista de estadísticas por jugador (solo customs)
CREATE OR REPLACE VIEW public.player_stats AS
SELECT
    gamertag,
    COUNT(*) as total_games,
    SUM(kills) as total_kills,
    SUM(deaths) as total_deaths,
    SUM(assists) as total_assists,
    SUM(score) as total_score,
    ROUND(AVG(kills)::numeric, 2) as avg_kills,
    ROUND(AVG(deaths)::numeric, 2) as avg_deaths,
    ROUND(AVG(assists)::numeric, 2) as avg_assists,
    ROUND(AVG(score)::numeric, 2) as avg_score,
    CASE
        WHEN SUM(deaths) > 0 THEN ROUND((SUM(kills)::numeric / SUM(deaths)::numeric), 2)
        ELSE SUM(kills)::numeric
    END as overall_kd,
    CASE
        WHEN SUM(deaths) > 0 THEN ROUND(((SUM(kills)::numeric + SUM(assists)::numeric) / SUM(deaths)::numeric), 2)
        ELSE (SUM(kills) + SUM(assists))::numeric
    END as overall_kda,
    MAX(most_kills_in_a_row) as best_spree,
    MAX(kills) as most_kills_single_game
FROM public.players p
INNER JOIN public.games g ON p.game_unique_id = g.game_unique_id
WHERE g.is_matchmaking = false
GROUP BY gamertag
ORDER BY total_score DESC;

-- Vista de partidas recientes (solo customs)
CREATE OR REPLACE VIEW public.recent_games AS
SELECT
    g.game_unique_id,
    g.map_name,
    g.game_type_name,
    g.timestamp,
    g.timestamp_cdmx,
    COUNT(p.id) as player_count,
    SUM(CASE WHEN p.team_id = 0 THEN p.score ELSE 0 END) as blue_score,
    SUM(CASE WHEN p.team_id = 1 THEN p.score ELSE 0 END) as red_score
FROM public.games g
LEFT JOIN public.players p ON g.game_unique_id = p.game_unique_id
WHERE g.is_matchmaking = false
GROUP BY g.game_unique_id, g.map_name, g.game_type_name, g.timestamp, g.timestamp_cdmx
ORDER BY g.timestamp DESC
LIMIT 50;

-- ============================================================
-- MENSAJE DE ÉXITO
-- ============================================================
-- Si llegas aquí sin errores, las vistas se actualizaron correctamente.
