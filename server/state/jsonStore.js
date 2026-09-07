/**
 * Almacén JSON compartido para el estado persistente en OUTPUT_DIR
 * (roster de WhatsApp, W.O., anuladas, ajustes de marcador, reset de
 * rondas, corte semanal de saldos). Fase A0 — "red de seguridad": mismo
 * comportamiento tolerante a archivo faltante/corrupto que ya tenía cada
 * módulo, pero centralizado, y con fsync antes del rename para que un
 * crash a medio guardado nunca deje el archivo real a medias.
 *
 * OUTPUT_DIR es un volumen montado del host (sobrevive redeploys); estos
 * archivos son la única fuente de verdad para varias reglas de negocio
 * (marcador de rondas, cuenta en $, roster de menciones), así que la
 * escritura debe ser atómica: tmp + fsync + rename, nunca un write directo.
 */

const fs = require('fs');
const path = require('path');

/**
 * Lee y parsea un JSON; tolerante a archivo faltante o corrupto.
 * @param {string} file - ruta completa del archivo
 * @param {*} fallback - valor a devolver si falta o no parsea (advertencia
 *   por consola SOLO cuando el archivo existe pero está corrupto; un
 *   archivo faltante es el caso normal de "primera vez" y no se loggea).
 */
function readJson(file, fallback) {
    let raw;
    try {
        raw = fs.readFileSync(file, 'utf-8');
    } catch (err) {
        if (err.code !== 'ENOENT') {
            console.warn(`⚠️  jsonStore: no se pudo leer ${file}: ${err.message}`);
        }
        return fallback;
    }
    try {
        return JSON.parse(raw);
    } catch (err) {
        console.warn(`⚠️  jsonStore: ${file} tiene JSON inválido, se ignora (${err.message})`);
        return fallback;
    }
}

/**
 * Escribe un JSON de forma atómica: tmp + fsync + rename. Si el proceso
 * muere a medio escribir, el `.tmp` queda huérfano (se pisa la próxima
 * vez) pero el archivo real nunca queda corrupto ni a medias.
 * @param {string} file - ruta completa del archivo
 * @param {*} data - datos a serializar
 * @param {{pretty?: boolean}} [opts] - pretty=true (default) indenta con 2
 *   espacios, igual que ya hacían roster/forfeits/anuladas/ajustes;
 *   pretty=false serializa compacto, igual que rondasReset/saldos.
 */
function writeJsonAtomic(file, data, { pretty = true } = {}) {
    const tmp = `${file}.tmp`;
    const json = pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data);
    const fd = fs.openSync(tmp, 'w');
    try {
        fs.writeFileSync(fd, json);
        fs.fsyncSync(fd);
    } finally {
        fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
}

// Candados en proceso por ruta absoluta de archivo (mismo patrón que
// makeLock() en index.js, pero indexado por archivo en vez de uno fijo).
const locks = new Map();

/**
 * Serializa lecturas-modificaciones-escrituras sobre el MISMO archivo: dos
 * llamadas concurrentes a withFileLock(file, fn) para el mismo archivo
 * corren en orden, nunca en paralelo. Archivos distintos no se bloquean
 * entre sí.
 * @param {string} file
 * @param {function(): (any|Promise<any>)} fn
 * @returns {Promise<any>}
 */
function withFileLock(file, fn) {
    const key = path.resolve(file);
    const prev = locks.get(key) || Promise.resolve();
    const run = prev.then(fn, fn);
    locks.set(key, run.then(() => undefined, () => undefined));
    return run;
}

module.exports = { readJson, writeJsonAtomic, withFileLock };
