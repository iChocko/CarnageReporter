/**
 * Resolución de nombres de mapa (lado servidor).
 *
 * El XML de MCC NO contiene el mapa: para customs se deduce del nombre de
 * archivo (`asq_<codigo>`), para matchmaking no existe el dato. El cliente
 * manda el código crudo (ej. "asq_guardia") y aquí se traduce a nombre bonito.
 *
 * Tener el diccionario en el SERVIDOR permite agregar/corregir mapas con un
 * redeploy, sin recompilar el .exe ni que los jugadores reinstalen.
 */

// Placeholder estético mientras un código no está mapeado (se recopila el
// código crudo aparte para identificarlo después).
const MAP_PLACEHOLDER = 'Mapa por confirmar';

// código (tal como aparece en el nombre de archivo) -> nombre para mostrar
const MAP_NAMES = {
    asq_chill: 'Narrows',
    asq_constru: 'Construct',
    asq_guardia: 'Guardian',
    asq_cyberdy: 'The Pit',
    asq_warehou: 'Foundry (Onslaught)',
    asq_midship: 'Heretic',
    asq_epitaph: 'Epitaph',
    asq_high_ground: 'High Ground',
    asq_isolation: 'Isolation',
    asq_last_resort: 'Last Resort',
    asq_sandtrap: 'Sandtrap',
    asq_snowbound: 'Snowbound',
    asq_the_pit: 'The Pit',
    asq_valhalla: 'Valhalla',
    asq_blackout: 'Blackout',
    asq_ghost_town: 'Ghost Town',
    asq_rat_nest: "Rat's Nest",
    asq_standoff: 'Standoff',
    asq_avalanche: 'Avalanche',
    asq_foundry: 'Foundry',
    asq_boundless: 'Snowbound (Boundless)',
    asq_glacier: 'Cold Storage',
    asq_orbital: 'Orbital',
    asq_assembly: 'Assembly',
    asq_citadel: 'Citadel',
    asq_heretic: 'Heretic',
    asq_longshore: 'Longshore',
    asq_sandbox: 'Sandbox',
    asq_tundra: 'Avalanche',
    asq_descent: 'Assembly',
};

/**
 * Normaliza un código: minúsculas, sin el timestamp del archivo si viniera pegado.
 */
function normalizeCode(code) {
    if (!code) return null;
    const m = String(code).toLowerCase().match(/asq_[a-z0-9_]+/);
    return m ? m[0] : null;
}

function isKnownMap(code) {
    const c = normalizeCode(code);
    return !!(c && MAP_NAMES[c]);
}

/**
 * Resuelve el nombre a mostrar y el código crudo a guardar.
 * @param {object} p
 * @param {string} [p.mapCode]   Código crudo del archivo (cliente v1.4.0+)
 * @param {string} [p.filename]  Nombre del archivo XML (todos los clientes lo mandan);
 *                               de aquí se extrae el código si no vino mapCode.
 * @param {string} [p.mapName]   Nombre ya resuelto por el cliente (compat clientes viejos)
 * @param {string} [p.gameTypeName] Tipo de juego (respaldo cuando no hay mapa: matchmaking)
 * @returns {{ mapName: string, mapCode: string|null }}
 */
function resolveMap({ mapCode, filename, mapName, gameTypeName }) {
    // El código puede venir explícito (v1.4.0) o extraerse del nombre de archivo
    // (funciona con clientes viejos: "asq_standoff-18-15.xml" -> "asq_standoff").
    const code = normalizeCode(mapCode) || normalizeCode(filename);

    // 1. Código conocido -> nombre bonito
    if (code && MAP_NAMES[code]) {
        return { mapName: MAP_NAMES[code], mapCode: code };
    }

    // 2. Código presente pero desconocido -> placeholder + se guarda el código
    if (code) {
        return { mapName: MAP_PLACEHOLDER, mapCode: code };
    }

    // 3. Sin código (matchmaking): no hay mapa. Usar el tipo de juego que sí trae el XML.
    const gt = (gameTypeName || '').trim();
    if (gt && !gt.startsWith('$')) {
        return { mapName: gt, mapCode: null };
    }

    // 4. Cliente viejo que mandó un mapName ya resuelto (no genérico) -> respetarlo
    const mn = (mapName || '').trim();
    if (mn && mn !== 'Halo 3 Match' && mn !== 'Halo 3 Map' && !mn.startsWith('$')) {
        return { mapName: mn, mapCode: null };
    }

    // 5. Último recurso
    return { mapName: 'Matchmaking', mapCode: null };
}

module.exports = { resolveMap, isKnownMap, normalizeCode, MAP_NAMES, MAP_PLACEHOLDER };
