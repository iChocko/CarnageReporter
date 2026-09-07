/**
 * Backup diario del estado local (Fase A0 — "red de seguridad").
 *
 * output/*.json (roster de WhatsApp, W.O., anuladas, ajustes de marcador,
 * reset de rondas, corte de saldos) y la sesión de WhatsApp (authDir) son
 * la ÚNICA copia de ese estado fuera de la base de datos: viven en un
 * volumen montado del host. Si ese volumen se pierde sin backup, se pierde
 * el roster de menciones, el marcador de rondas, las deudas pendientes y
 * la sesión de WhatsApp (habría que volver a escanear el QR).
 *
 * runBackup hace dos cosas independientes (una puede fallar sin tumbar la
 * otra, así que cada JSON se sube por separado y se atrapa su propio error):
 *  1. Empaqueta output/*.json + authDir en un .tar.gz local, en
 *     output/backups/state-YYYYMMDD-HHmm.tar.gz, y poda los más viejos que
 *     `keepDays`.
 *  2. Sube cada JSON individual a Supabase (tabla state_backups) como
 *     segunda copia FUERA del host, por si el volumen se pierde entero.
 */

const fs = require('fs');
const path = require('path');
const tar = require('tar');

const BACKUP_SUBDIR = 'backups';
const ARCHIVE_NAME_RE = /^state-\d{8}-\d{4}\.tar\.gz$/;

function pad2(n) {
    return String(n).padStart(2, '0');
}

/** state-YYYYMMDD-HHmm.tar.gz, en hora local del proceso (VPS en CDMX). */
function backupFileName(ts) {
    const d = new Date(ts);
    const stamp = `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}`;
    return `state-${stamp}.tar.gz`;
}

/**
 * @param {object} opts
 * @param {string} opts.outputDir - OUTPUT_DIR (server/output)
 * @param {string} [opts.authDir] - directorio de sesión de WhatsApp (LocalAuth)
 * @param {object} opts.supabase - instancia de SupabaseService (o un fake en tests)
 * @param {number} [opts.keepDays=14] - retención de backups locales
 * @param {number|function(): number} [opts.now=Date.now]
 * @returns {Promise<{archivePath: string|null, jsonFiles: number, uploaded: number, pruned: number}>}
 */
async function runBackup({ outputDir, authDir, supabase, keepDays = 14, now = Date.now } = {}) {
    const nowMs = typeof now === 'function' ? now() : now;
    const backupDir = path.join(outputDir, BACKUP_SUBDIR);
    fs.mkdirSync(backupDir, { recursive: true });

    const jsonFiles = fs.existsSync(outputDir)
        ? fs.readdirSync(outputDir).filter(f => f.endsWith('.json'))
        : [];

    // 1a. Empaquetar output/*.json + authDir en un .tar.gz local. Se usa el
    //     padre de outputDir como raíz común (normalmente "server/"), donde
    //     output/ y el directorio de sesión de WhatsApp son hermanos.
    const base = path.dirname(outputDir);
    const outputBase = path.basename(outputDir);
    const entries = jsonFiles.map(f => path.join(outputBase, f));
    const hasAuthDir = Boolean(authDir) && fs.existsSync(authDir);
    if (hasAuthDir) entries.push(path.relative(base, authDir));

    let archivePath = null;
    if (entries.length > 0) {
        archivePath = path.join(backupDir, backupFileName(nowMs));
        await tar.create({ gzip: true, file: archivePath, cwd: base }, entries);
    } else {
        console.warn('⚠️  backup: nada que empaquetar (sin JSON de estado ni sesión de WhatsApp)');
    }

    // 1b. Podar backups locales más viejos que keepDays.
    const cutoff = nowMs - keepDays * 24 * 60 * 60 * 1000;
    let pruned = 0;
    for (const f of fs.readdirSync(backupDir)) {
        if (!ARCHIVE_NAME_RE.test(f)) continue;
        const filePath = path.join(backupDir, f);
        if (fs.statSync(filePath).mtimeMs < cutoff) {
            fs.unlinkSync(filePath);
            pruned++;
        }
    }

    // 2. Segunda copia fuera del host: cada JSON individual a Supabase.
    //    Un JSON corrupto o un error de red no debe tumbar el backup de los
    //    demás archivos ni el empaquetado local (ya hecho arriba).
    let uploaded = 0;
    const takenAt = new Date(nowMs).toISOString();
    for (const file of jsonFiles) {
        try {
            const content = JSON.parse(fs.readFileSync(path.join(outputDir, file), 'utf-8'));
            const ok = await supabase.saveStateBackup(file, takenAt, content);
            if (ok) uploaded++;
        } catch (err) {
            console.error(`⚠️  backup: no se pudo subir ${file} a Supabase: ${err.message}`);
        }
    }

    return { archivePath, jsonFiles: jsonFiles.length, uploaded, pruned };
}

module.exports = { runBackup, backupFileName, BACKUP_SUBDIR };
