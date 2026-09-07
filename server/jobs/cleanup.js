/**
 * Limpieza diaria de imágenes viejas en OUTPUT_DIR (Fase A0).
 *
 * Cada partida genera un output/match_<id>.png que se manda a Discord/
 * WhatsApp y ya no hace falta después (la partida sigue completa en
 * Supabase). Sin esto, output/ crece sin límite en el volumen del host.
 *
 * NUNCA toca los .json de estado (roster, W.O., anuladas, ajustes, reset,
 * corte) ni output/backups/ (backup.js poda sus propios archivos aparte).
 */

const fs = require('fs');
const path = require('path');

const PNG_RE = /^match_.*\.png$/i;

/**
 * @param {object} opts
 * @param {string} opts.outputDir - OUTPUT_DIR (server/output)
 * @param {number} [opts.maxAgeDays=14] - antigüedad máxima antes de borrar
 * @param {number|function(): number} [opts.now=Date.now]
 * @returns {Promise<{deleted: number}>}
 */
async function runCleanup({ outputDir, maxAgeDays = 14, now = Date.now } = {}) {
    if (!fs.existsSync(outputDir)) return { deleted: 0 };
    const nowMs = typeof now === 'function' ? now() : now;
    const cutoff = nowMs - maxAgeDays * 24 * 60 * 60 * 1000;

    let deleted = 0;
    for (const f of fs.readdirSync(outputDir)) {
        if (!PNG_RE.test(f)) continue;
        const filePath = path.join(outputDir, f);
        const stat = fs.statSync(filePath);
        if (stat.isFile() && stat.mtimeMs < cutoff) {
            fs.unlinkSync(filePath);
            deleted++;
        }
    }
    return { deleted };
}

module.exports = { runCleanup };
