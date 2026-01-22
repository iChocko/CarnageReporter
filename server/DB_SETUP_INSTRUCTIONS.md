# Carnage Reporter - Database Setup Instructions

The server detected that the required database tables do not exist. Since the `DATABASE_URL` is not configured, the server cannot create them automatically.

Please follow these steps to set up your Supabase database:

1.  **Log in to Supabase:** Go to [https://supabase.com/dashboard](https://supabase.com/dashboard) and select your project.
2.  **Open SQL Editor:** Click on the "SQL Editor" icon in the left sidebar.
3.  **New Query:** Click "New Query".
4.  **Copy & Paste:** Copy the SQL code below and paste it into the editor.
5.  **Run:** Click the "Run" button (bottom right).

## SQL Code to Run

```sql
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

-- Habilitar RLS
ALTER TABLE public.games ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.players ENABLE ROW LEVEL SECURITY;

-- Política para permitir inserción con service_role key
CREATE POLICY "Allow service role full access to games" ON public.games
    FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "Allow service role full access to players" ON public.players
    FOR ALL USING (true) WITH CHECK (true);
```
