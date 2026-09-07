/**
 * Backup diario del estado local (Fase A0 — "red de seguridad").
 *
 * output/*.json (roster de WhatsApp, W.O., anuladas, ajustes de marcador,
 * reset de rondas, corte de saldos) es la ÚNICA copia de ese estado fuera
 * de la base de datos: vive en un volumen montado del host. Si ese volumen
 * se pierde sin backup, se pierde el roster de menciones, el marcador de
 * rondas y las deudas pendientes.
 *
 * La sesión de WhatsApp (authDir, whatsapp-web.js LocalAuth) es un perfil
 * de Chromium vivo (IndexedDB, Cache, Code Cache, GPUCache, Service
 * Worker, *.pma, Singleton*...) de 170 MB+ que cambia mientras el proceso
 * corre. Por default NO se incluye en el tar: pesa demasiado para
 * empaquetar a diario y puede fallar por archivos bloqueados/cambiando a
 * medio tar. Se puede incluir con `includeAuthDir: true`
 * (BACKUP_INCLUDE_AUTH=true), en cuyo caso se excluyen del tar las
 * subcarpetas de caché/telemetría de Chromium y se conservan Local
 * Storage / Session Storage / IndexedDB (ahí vive el login).
 *
 * runBackup hace dos cosas independientes (una puede fallar sin tumbar la
 * otra):
 *  1. Sube cada JSON individual a Supabase (tabla state_backups) como
 *     segunda copia FUERA del host, por si el volumen se pierde entero.
 *     Esto va PRIMERO: si el tar local de abajo truena, esta copia ya
 *     quedó a salvo.
 *  2. Empaqueta output/*.json (+ authDir si includeAuthDir) en un .tar.gz
 *     local, en output/backups/state-YYYYMMDD-HHmm.tar.gz, y poda los más
 *     viejos que `keepDays`. Un fallo aquí (tar.create tronando) se
 *     atrapa y solo deja `archivePath: null`; no debe tumbar la subida ya
 *     hecha en el paso 1.
 */

const fs = require('fs');
const path = require('path');
const tar = require('tar');

const BACKUP_SUBDIR = 'backups';
const ARCHIVE_NAME_RE = /^state-\d{8}-\d{4}\.tar\.gz$/;

// Nombres exactos de carpeta (un segmento completo de la ruta) que
// identifican carpetas de caché/telemetría de Chromium dentro del perfil
// de whatsapp-web.js. Se excluyen del tar (con toda su subcarpeta) cuando
// includeAuthDir=true. Local Storage / Session Storage / IndexedDB NO
// están aquí a propósito: ahí vive la sesión de WhatsApp.
const AUTH_DIR_EXCLUDE_DIR_NAMES = new Set([
    'Cache',
    'Code Cache',
    'GPUCache',
    'DawnCache',
    'DawnGraphiteCache',
    'DawnWebGPUCache',
    'Service Worker',
    'Crashpad',
    'blob_storage',
]);

// Subcadenas que, si aparecen en CUALQUIER segmento de la ruta (nombre de
// carpeta o archivo), marcan esa entrada como excluible: métricas,
// lockfiles de Chromium (Singleton*, DevToolsActivePort) y archivos de
// base de datos LevelDB/IndexedDB temporales (*.pma).
const AUTH_DIR_EXCLUDE_SUBSTRINGS = ['BrowserMetrics', 'Singleton', '.pma', 'DevToolsActivePort'];

/** true si la entrada del tar (ruta relativa al cwd del archive) cae dentro de una carpeta de caché de Chromium que no queremos respaldar. */
function isExcludedAuthPath(entryPath) {
    const segments = String(entryPath).replace(/\\/g, '/').split('/');
    if (segments.some(seg => AUTH_DIR_EXCLUDE_DIR_NAMES.has(seg))) return true;
    return segments.some(seg => AUTH_DIR_EXCLUDE_SUBSTRINGS.some(pattern => seg.includes(pattern)));
}

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
 * @param {boolean} [opts.includeAuthDir=false] - si true, incluye authDir en el
 *   tar local (excluyendo cachés de Chromium). Opt-in: por default el perfil
 *   de Chromium de whatsapp-web.js NO se empaqueta (ver comentario arriba).
 * @param {function(object, string[]): Promise<*>} [opts.createArchive] - hook de
 *   pruebas para reemplazar `tar.create`; recibe (tarOptions, entries).
 * @returns {Promise<{archivePath: string|null, jsonFiles: number, uploaded: number, pruned: number}>}
 */
async function runBackup({
    outputDir,
    authDir,
    supabase,
    keepDays = 14,
    now = Date.now,
    includeAuthDir = false,
    createArchive,
} = {}) {
    const nowMs = typeof now === 'function' ? now() : now;
    const backupDir = path.join(outputDir, BACKUP_SUBDIR);
    fs.mkdirSync(backupDir, { recursive: true });

    const jsonFiles = fs.existsSync(outputDir)
        ? fs.readdirSync(outputDir).filter(f => f.endsWith('.json'))
        : [];

    // 1. Segunda copia fuera del host PRIMERO: cada JSON individual a
    //    Supabase. Un JSON corrupto o un error de red no debe tumbar el
    //    backup de los demás archivos; y si el tar local (paso 2) truena,
    //    esta copia ya quedó a salvo.
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

    // 2a. Empaquetar output/*.json (+ authDir si includeAuthDir) en un
    //     .tar.gz local. Se usa el padre de outputDir como raíz común
    //     (normalmente "server/"), donde output/ y el directorio de sesión
    //     de WhatsApp son hermanos.
    const base = path.dirname(outputDir);
    const outputBase = path.basename(outputDir);
    const entries = jsonFiles.map(f => path.join(outputBase, f));

    let hasAuthDir = includeAuthDir && Boolean(authDir) && fs.existsSync(authDir);
    if (hasAuthDir) {
        const relAuth = path.relative(base, authDir);
        if (relAuth.startsWith('..')) {
            console.warn(`⚠️  backup: authDir (${authDir}) queda fuera de ${base}, tar no puede incluir rutas fuera de su cwd; se omite`);
            hasAuthDir = false;
        } else {
            entries.push(relAuth);
        }
    }

    let archivePath = null;
    if (entries.length > 0) {
        archivePath = path.join(backupDir, backupFileName(nowMs));
        const tarOptions = { gzip: true, file: archivePath, cwd: base };
        if (hasAuthDir) {
            tarOptions.filter = entryPath => !isExcludedAuthPath(entryPath);
        }
        try {
            const archiver = createArchive || ((opts, ents) => tar.create(opts, ents));
            await archiver(tarOptions, entries);
        } catch (err) {
            console.error(`⚠️  backup: no se pudo crear el tar local: ${err.message}`);
            archivePath = null;
        }
    } else {
        console.warn('⚠️  backup: nada que empaquetar (sin JSON de estado ni sesión de WhatsApp)');
    }

    // 2b. Podar backups locales más viejos que keepDays (solo si el tar de
    //     arriba pudo crear/mantener el directorio; backupDir ya existe
    //     desde el mkdirSync inicial aunque el tar haya fallado).
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

    return { archivePath, jsonFiles: jsonFiles.length, uploaded, pruned };
}

module.exports = { runBackup, backupFileName, BACKUP_SUBDIR };
