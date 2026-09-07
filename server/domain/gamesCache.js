/**
 * Cache en memoria de partidas leídas de Supabase (Fase A2).
 *
 * ÚNICO cambio de comportamiento intencional de la Fase A2: antes cada
 * endpoint/comando llamaba a `supabase.getAllValidGamesWithPlayers(format)` o
 * `getRecentGamesWithPlayers(limit, format)` directo, así que una ráfaga de
 * requests (dashboard + comandos de WhatsApp casi simultáneos) repetía la
 * misma consulta N veces. Este wrapper:
 *
 *  - Cachea cada combinación de argumentos por `ttlMs` (default 5 min,
 *    configurable con STATS_CACHE_TTL_MS).
 *  - Deduplica llamadas concurrentes con los mismos argumentos: si ya hay una
 *    consulta en vuelo, las demás esperan esa misma promesa en vez de lanzar
 *    otra igual.
 *  - `invalidateAll()` limpia todo el cache; se llama después de cualquier
 *    escritura que cambie el conjunto de partidas válidas (saveGame,
 *    setVoided, deleteGame, forfeits/anuladas/ajustes, `!rondas reset`,
 *    map-backfill).
 *
 * Lectura entonces "stale" hasta `ttlMs` como mucho, salvo que algo la
 * invalide antes.
 */

'use strict';

const DEFAULT_TTL_MS = 5 * 60 * 1000;

/**
 * @param {object} opts
 * @param {{ getAllValidGamesWithPlayers: function, getRecentGamesWithPlayers: function }} opts.supabase
 * @param {number} [opts.ttlMs]
 * @param {() => number} [opts.now] - inyectable para tests
 * @returns {{ getAllValidGamesWithPlayers: function, getRecentGamesWithPlayers: function, invalidateAll: function }}
 */
function createGamesCache({ supabase, ttlMs, now = Date.now }) {
    const effectiveTtlMs = ttlMs ?? (Number(process.env.STATS_CACHE_TTL_MS) || DEFAULT_TTL_MS);

    const validCache = new Map();   // format -> { at, value }
    const validInFlight = new Map(); // format -> Promise
    const recentCache = new Map();   // "limit:format" -> { at, value }
    const recentInFlight = new Map(); // "limit:format" -> Promise

    function memoize(cache, inFlight, key, fetcher) {
        const cached = cache.get(key);
        if (cached && now() - cached.at < effectiveTtlMs) {
            return Promise.resolve(cached.value);
        }
        const pending = inFlight.get(key);
        if (pending) return pending;

        const promise = Promise.resolve()
            .then(fetcher)
            .then((value) => {
                cache.set(key, { at: now(), value });
                inFlight.delete(key);
                return value;
            })
            .catch((err) => {
                inFlight.delete(key);
                throw err;
            });
        inFlight.set(key, promise);
        return promise;
    }

    function getAllValidGamesWithPlayers(format) {
        return memoize(validCache, validInFlight, format, () => supabase.getAllValidGamesWithPlayers(format));
    }

    function getRecentGamesWithPlayers(limit, format) {
        const key = `${limit}:${format}`;
        return memoize(recentCache, recentInFlight, key, () => supabase.getRecentGamesWithPlayers(limit, format));
    }

    function invalidateAll() {
        validCache.clear();
        recentCache.clear();
    }

    return { getAllValidGamesWithPlayers, getRecentGamesWithPlayers, invalidateAll };
}

module.exports = { createGamesCache, DEFAULT_TTL_MS };
