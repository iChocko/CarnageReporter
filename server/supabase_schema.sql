-- ============================================================
-- CARNAGE REPORTER - SCHEMA DE BASE DE DATOS (v2, consolidado)
-- ============================================================
-- Ejecutar UNA VEZ en el SQL Editor del proyecto Supabase nuevo:
-- https://supabase.com/dashboard
--
-- Este archivo reemplaza a los antiguos supabase_migration.sql,
-- update_views_customs_only.sql y update_views_include_all.sql.
-- ============================================================

-- Tabla de juegos (partidas)
CREATE TABLE IF NOT EXISTS public.games (
    id SERIAL PRIMARY KEY,
    game_unique_id VARCHAR(255) UNIQUE NOT NULL,
    game_enum INTEGER DEFAULT 0,
    is_matchmaking BOOLEAN DEFAULT FALSE,
    is_teams_enabled BOOLEAN DEFAULT TRUE,
    hopper_name VARCHAR(255),
    game_type_name VARCHAR(255),
    map_name VARCHAR(255),
    duration INTEGER DEFAULT 0,                  -- segundos (max mSecondsPlayed)
    playlist_name VARCHAR(255),
    last_match_incomplete BOOLEAN DEFAULT FALSE, -- flag crudo del XML
    party_size INTEGER,
    is_voided BOOLEAN NOT NULL DEFAULT FALSE,    -- partida anulada (no cuenta para stats)
    void_reason TEXT,                            -- unsupported_format | last_match_incomplete | too_short | majority_quit | manual
    schema_version INTEGER DEFAULT 1,            -- versión del payload del cliente
    client_version VARCHAR(20),
    format VARCHAR(8),                           -- '2v2' | '4v4' (derivado de la estructura de equipos)
    map_code VARCHAR(64),                        -- código crudo del mapa (ej. asq_guardia); para mapear desconocidos
    timestamp TIMESTAMPTZ DEFAULT NOW(),
    timestamp_cdmx TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Índices para búsquedas rápidas
CREATE INDEX IF NOT EXISTS idx_games_timestamp ON public.games(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_games_map_name ON public.games(map_name);
CREATE INDEX IF NOT EXISTS idx_games_voided ON public.games(is_voided);
CREATE INDEX IF NOT EXISTS idx_games_format ON public.games(format);
CREATE INDEX IF NOT EXISTS idx_games_map_code ON public.games(map_code);
-- Para búsqueda por prefijo de ID (borrado admin con ID corto)
CREATE INDEX IF NOT EXISTS idx_games_id_prefix ON public.games(game_unique_id varchar_pattern_ops);

-- ============================================================
-- MIGRACIÓN para bases ya existentes (correr una sola vez):
--   ALTER TABLE public.games ADD COLUMN IF NOT EXISTS format VARCHAR(8);
--   ALTER TABLE public.games ADD COLUMN IF NOT EXISTS map_code VARCHAR(64);
--   CREATE INDEX IF NOT EXISTS idx_games_format ON public.games(format);
--   CREATE INDEX IF NOT EXISTS idx_games_map_code ON public.games(map_code);
-- ============================================================

-- Tabla de jugadores (stats por partida)
CREATE TABLE IF NOT EXISTS public.players (
    id SERIAL PRIMARY KEY,
    game_unique_id VARCHAR(255) NOT NULL REFERENCES public.games(game_unique_id) ON DELETE CASCADE,
    xbox_user_id VARCHAR(255),
    gamertag VARCHAR(255) NOT NULL,
    clan_tag VARCHAR(50),
    service_id VARCHAR(50),
    team_id INTEGER DEFAULT 0,
    score INTEGER DEFAULT 0,
    standing INTEGER DEFAULT 0,
    kills INTEGER DEFAULT 0,
    deaths INTEGER DEFAULT 0,
    assists INTEGER DEFAULT 0,
    betrayals INTEGER DEFAULT 0,
    suicides INTEGER DEFAULT 0,
    most_kills_in_a_row INTEGER DEFAULT 0,
    seconds_played INTEGER DEFAULT 0,
    seconds_alive INTEGER DEFAULT 0,
    completed_game SMALLINT,                     -- 1/0; NULL = desconocido (cliente v1)
    kills_weapon INTEGER DEFAULT 0,
    kills_grenade INTEGER DEFAULT 0,
    kills_melee INTEGER DEFAULT 0,
    kills_other INTEGER DEFAULT 0,
    is_guest BOOLEAN DEFAULT FALSE,
    medals JSONB,                                -- [{"id": 123, "count": 2}, ...]
    player_index INTEGER,
    kd_ratio NUMERIC(6,2),
    created_at TIMESTAMPTZ DEFAULT NOW(),

    -- Evitar duplicados: mismo jugador en misma partida
    UNIQUE(game_unique_id, xbox_user_id)
);

-- Índices para búsquedas rápidas
CREATE INDEX IF NOT EXISTS idx_players_gamertag ON public.players(gamertag);
CREATE INDEX IF NOT EXISTS idx_players_game_id ON public.players(game_unique_id);

-- ============================================================
-- POLÍTICAS DE SEGURIDAD (RLS)
-- ============================================================
-- El servidor usa la service_role key (bypassa RLS). RLS queda
-- habilitado para que la anon key NO pueda escribir nada.

ALTER TABLE public.games ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.players ENABLE ROW LEVEL SECURITY;

-- Lectura pública (dashboard puede leer con anon key si hiciera falta)
CREATE POLICY "Public read access to games" ON public.games
    FOR SELECT USING (true);

CREATE POLICY "Public read access to players" ON public.players
    FOR SELECT USING (true);

-- ============================================================
-- VISTA: Estadísticas por jugador (agregadas)
-- Criterio único en todo el sistema: solo customs válidas
-- (is_voided = FALSE AND is_matchmaking = FALSE)
-- ============================================================

CREATE OR REPLACE VIEW public.player_stats AS
SELECT
    p.gamertag,
    COUNT(*) as total_games,
    SUM(p.kills) as total_kills,
    SUM(p.deaths) as total_deaths,
    SUM(p.assists) as total_assists,
    SUM(p.score) as total_score,
    ROUND(AVG(p.kills)::numeric, 2) as avg_kills,
    ROUND(AVG(p.deaths)::numeric, 2) as avg_deaths,
    ROUND(AVG(p.assists)::numeric, 2) as avg_assists,
    ROUND(AVG(p.score)::numeric, 2) as avg_score,
    CASE
        WHEN SUM(p.deaths) > 0 THEN ROUND((SUM(p.kills)::numeric / SUM(p.deaths)::numeric), 2)
        ELSE SUM(p.kills)::numeric
    END as overall_kd,
    CASE
        WHEN SUM(p.deaths) > 0 THEN ROUND(((SUM(p.kills)::numeric + SUM(p.assists)::numeric) / SUM(p.deaths)::numeric), 2)
        ELSE (SUM(p.kills) + SUM(p.assists))::numeric
    END as overall_kda,
    MAX(p.most_kills_in_a_row) as best_spree,
    MAX(p.kills) as most_kills_single_game
FROM public.players p
INNER JOIN public.games g ON p.game_unique_id = g.game_unique_id
WHERE g.is_voided = FALSE
  AND g.is_matchmaking = FALSE
GROUP BY p.gamertag
ORDER BY total_score DESC;

-- ============================================================
-- VISTA: Últimas partidas (solo customs válidas)
-- ============================================================

CREATE OR REPLACE VIEW public.recent_games AS
SELECT
    g.game_unique_id,
    g.map_name,
    g.game_type_name,
    g.is_teams_enabled,
    g.duration,
    g.timestamp,
    g.timestamp_cdmx,
    COUNT(p.id) as player_count,
    SUM(CASE WHEN p.team_id = 0 THEN p.score ELSE 0 END) as blue_score,
    SUM(CASE WHEN p.team_id = 1 THEN p.score ELSE 0 END) as red_score
FROM public.games g
LEFT JOIN public.players p ON g.game_unique_id = p.game_unique_id
WHERE g.is_voided = FALSE
  AND g.is_matchmaking = FALSE
GROUP BY g.game_unique_id, g.map_name, g.game_type_name, g.is_teams_enabled,
         g.duration, g.timestamp, g.timestamp_cdmx
ORDER BY g.timestamp DESC
LIMIT 50;

-- ============================================================
-- Verificación: si llegas aquí sin errores, todo quedó creado.
-- SELECT * FROM public.games LIMIT 1;
-- ============================================================
