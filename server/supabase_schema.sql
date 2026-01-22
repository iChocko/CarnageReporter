-- ============================================================
-- CARNAGE REPORTER - SCHEMA DE BASE DE DATOS
-- ============================================================
-- Ejecutar en Supabase SQL Editor: https://supabase.com/dashboard
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
    timestamp TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Índices para búsquedas rápidas
CREATE INDEX IF NOT EXISTS idx_games_timestamp ON public.games(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_games_map_name ON public.games(map_name);

-- Tabla de jugadores (stats por partida)
CREATE TABLE IF NOT EXISTS public.players (
    id SERIAL PRIMARY KEY,
    game_unique_id VARCHAR(255) NOT NULL,
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
    created_at TIMESTAMPTZ DEFAULT NOW(),

    -- Evitar duplicados: mismo jugador en misma partida
    UNIQUE(game_unique_id, xbox_user_id),

    -- Referencia a la tabla de juegos
    FOREIGN KEY (game_unique_id) REFERENCES public.games(game_unique_id) ON DELETE CASCADE
);

-- Índices para búsquedas rápidas
CREATE INDEX IF NOT EXISTS idx_players_gamertag ON public.players(gamertag);
CREATE INDEX IF NOT EXISTS idx_players_game_id ON public.players(game_unique_id);

-- ============================================================
-- POLÍTICAS DE SEGURIDAD (RLS)
-- ============================================================

-- Habilitar RLS
ALTER TABLE public.games ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.players ENABLE ROW LEVEL SECURITY;

-- Política para permitir inserción con service_role key
CREATE POLICY "Allow service role full access to games" ON public.games
    FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "Allow service role full access to players" ON public.players
    FOR ALL USING (true) WITH CHECK (true);

-- ============================================================
-- VISTA: Estadísticas por jugador (agregadas)
-- ============================================================

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
    CASE
        WHEN SUM(deaths) > 0 THEN ROUND((SUM(kills)::numeric / SUM(deaths)::numeric), 2)
        ELSE SUM(kills)::numeric
    END as overall_kd,
    MAX(most_kills_in_a_row) as best_spree
FROM public.players
GROUP BY gamertag
ORDER BY total_score DESC;

-- ============================================================
-- VISTA: Últimas partidas
-- ============================================================

CREATE OR REPLACE VIEW public.recent_games AS
SELECT
    g.game_unique_id,
    g.map_name,
    g.game_type_name,
    g.timestamp,
    COUNT(p.id) as player_count,
    SUM(CASE WHEN p.team_id = 0 THEN p.score ELSE 0 END) as blue_score,
    SUM(CASE WHEN p.team_id = 1 THEN p.score ELSE 0 END) as red_score
FROM public.games g
LEFT JOIN public.players p ON g.game_unique_id = p.game_unique_id
GROUP BY g.game_unique_id, g.map_name, g.game_type_name, g.timestamp
ORDER BY g.timestamp DESC
LIMIT 50;

-- ============================================================
-- MENSAJE DE ÉXITO
-- ============================================================
-- Si llegas aquí sin errores, las tablas se crearon correctamente.
-- Puedes verificar con: SELECT * FROM public.games LIMIT 1;
