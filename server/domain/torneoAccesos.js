/**
 * Accesos individuales de los organizadores del torneo (tabla
 * torneo_accesos en Supabase). Se administran desde Supabase: apagar
 * `activo` revoca el acceso en <= TTL sin redeploy; para crear uno se
 * inserta el sha256 de la clave (ver supabase_schema.sql "MIGRACIÓN T1").
 *
 * Cachea el resultado por hash (también los rechazos) para no pegarle a
 * Supabase en cada request del panel.
 */

'use strict';

const { hashKey } = require('../http/auth');
const { logger } = require('../logger');

const log = logger.child({ mod: 'torneo' });

const DEFAULT_TTL_MS = 60 * 1000;
const TOUCH_EVERY_MS = 10 * 60 * 1000;

/**
 * @param {{ getTorneoAcceso: function, touchTorneoAcceso?: function }} supabase
 * @returns {(key: string) => Promise<{id, nombre}|null>}
 */
function createAccesoLookup(supabase, { ttlMs = DEFAULT_TTL_MS, now = Date.now } = {}) {
    const cache = new Map();   // hash -> { at, acceso }
    const touched = new Map(); // id -> ts del último "último uso" escrito

    return async function lookupAcceso(key) {
        if (typeof supabase?.getTorneoAcceso !== 'function') return null;
        const hash = hashKey(key);
        const hit = cache.get(hash);
        let acceso;
        if (hit && now() - hit.at < ttlMs) {
            acceso = hit.acceso;
        } else {
            acceso = await supabase.getTorneoAcceso(hash);
            cache.set(hash, { at: now(), acceso });
        }
        if (acceso && typeof supabase.touchTorneoAcceso === 'function' &&
            (!touched.has(acceso.id) || now() - touched.get(acceso.id) > TOUCH_EVERY_MS)) {
            touched.set(acceso.id, now());
            supabase.touchTorneoAcceso(acceso.id)
                .catch(err => log.warn({ err }, 'No se pudo marcar el último uso del acceso'));
        }
        return acceso;
    };
}

module.exports = { createAccesoLookup };
