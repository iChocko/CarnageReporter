-- ============================================================
-- CARNAGE REPORTER - MIGRACIÓN DE CAMPOS FALTANTES
-- ============================================================
-- Ejecutar en Supabase SQL Editor: https://supabase.com/dashboard
-- Proyecto: isxjfvrdnmrwxyzfbvua
-- ============================================================

-- 1. Agregar campos faltantes a la tabla games
ALTER TABLE public.games 
ADD COLUMN IF NOT EXISTS duration INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS playlist_name VARCHAR(255);

COMMENT ON COLUMN public.games.duration IS 'Duración del juego en segundos';
COMMENT ON COLUMN public.games.playlist_name IS 'Nombre de la playlist o modo de juego';

-- 2. Agregar campos calculados a la tabla players
ALTER TABLE public.players
ADD COLUMN IF NOT EXISTS player_index INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS kd_ratio NUMERIC(5,2) DEFAULT 0;

COMMENT ON COLUMN public.players.player_index IS 'Índice del jugador en su equipo (ordenado por score descendente)';
COMMENT ON COLUMN public.players.kd_ratio IS 'Ratio de kills/deaths del jugador en esta partida';

-- ============================================================
-- MENSAJE DE ÉXITO
-- ============================================================
-- Si llegas aquí sin errores, la migración se aplicó correctamente.
-- Verifica con: SELECT * FROM public.games LIMIT 1;
-- Verifica con: SELECT * FROM public.players LIMIT 1;

SELECT 'Migración completada exitosamente' as status;
