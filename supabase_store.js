/**
 * SupabaseStore - Adaptador para wwebjs RemoteAuth
 * 
 * Permite guardar y recuperar la sesión de WhatsApp desde Supabase Storage.
 * Esto permite que múltiples instancias del EXE compartan la misma sesión.
 */

const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');
const os = require('os');
const archiver = require('archiver');
const unzipper = require('unzipper');

class SupabaseStore {
    constructor(options = {}) {
        this.supabaseUrl = options.supabaseUrl || process.env.SUPABASE_URL;
        this.supabaseKey = options.supabaseKey || process.env.SUPABASE_KEY;
        this.bucketName = options.bucketName || 'whatsapp-sessions';
        this.dataPath = options.dataPath || path.join(process.cwd(), '.wwebjs_auth');

        if (!this.supabaseUrl || !this.supabaseKey) {
            throw new Error('SupabaseStore: supabaseUrl y supabaseKey son requeridos');
        }

        this.supabase = createClient(this.supabaseUrl, this.supabaseKey);
        console.log('📦 SupabaseStore inicializado');

        // Intentar asegurar que el bucket exista
        this._ensureBucketExists();
    }

    async _ensureBucketExists() {
        try {
            const { data: buckets, error: listError } = await this.supabase.storage.listBuckets();
            if (listError) throw listError;

            const exists = buckets.some(b => b.name === this.bucketName);
            if (!exists) {
                console.log(`📡 Creando bucket "${this.bucketName}" en Supabase...`);
                const { error: createError } = await this.supabase.storage.createBucket(this.bucketName, {
                    public: false
                });
                if (createError) throw createError;
                console.log(`✅ Bucket "${this.bucketName}" creado con éxito`);
            }
        } catch (e) {
            console.log(`⚠️  No se pudo verificar/crear el bucket: ${e.message}`);
            console.log(`   Asegúrate de crearlo manualmente en el panel de Supabase si falla el guardado.`);
        }
    }

    async sessionExists(options) {
        const sessionName = options.session || 'default';
        const filePath = `${sessionName}/session.zip`;

        try {
            const { data, error } = await this.supabase.storage
                .from(this.bucketName)
                .list(sessionName);

            if (error) {
                console.log(`⚠️  Error verificando sesión: ${error.message}`);
                return false;
            }

            const exists = data && data.some(f => f.name === 'session.zip');
            console.log(`📂 Sesión "${sessionName}" ${exists ? 'encontrada' : 'no encontrada'} en Supabase`);
            return exists;
        } catch (e) {
            console.error('❌ Error en sessionExists:', e.message);
            return false;
        }
    }

    async save(options) {
        const sessionName = options.session || 'default';
        // Forzar que la ruta sea absoluta y esté dentro de dataPath si es relativa
        let localPath = options.path;
        if (!localPath) {
            localPath = path.join(this.dataPath, sessionName);
        } else if (!path.isAbsolute(localPath)) {
            // Si wwebjs nos da una ruta relativa, la asocia a dataPath
            localPath = path.join(this.dataPath, localPath);
        }

        try {
            console.log(`💾 Intentando guardar sesión "${sessionName}"`);
            console.log(`   Ruta origen: ${localPath}`);

            if (!fs.existsSync(localPath)) {
                console.log(`   ℹ️  La carpeta todavía no existe (esperando datos...)`);
                return false;
            }

            // Si es un archivo (zip) en lugar de carpeta, no podemos guardarlo así
            if (!fs.statSync(localPath).isDirectory()) {
                console.log(`   ⚠️ La ruta de origen no es un directorio, saltando...`);
                return false;
            }

            // Verificar contenido
            const files = fs.readdirSync(localPath);
            if (files.length === 0) {
                console.log(`⚠️  La carpeta está vacía.`);
                return false;
            }

            // Crear un zip del directorio de sesión
            const tmpDir = os.tmpdir();
            const zipPath = path.join(tmpDir, `wwebjs-save-${Date.now()}.zip`);
            await this._zipDirectory(localPath, zipPath);

            // Leer el zip y subirlo
            const zipData = fs.readFileSync(zipPath);

            const { data, error } = await this.supabase.storage
                .from(this.bucketName)
                .upload(`${sessionName}/session.zip`, zipData, {
                    contentType: 'application/zip',
                    upsert: true
                });

            // Limpiar archivo temporal
            try { if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath); } catch (e) { }

            if (error) throw error;

            console.log('✅ Sesión guardada en Supabase exitosamente');
            return true;
        } catch (e) {
            console.error('❌ Error guardando sesión en Supabase:', e.message);
            return false;
        }
    }

    async extract(options) {
        const sessionName = options.session || 'default';
        let targetPath = options.path;
        if (!targetPath) {
            targetPath = path.join(this.dataPath, sessionName);
        } else if (!path.isAbsolute(targetPath)) {
            targetPath = path.join(this.dataPath, targetPath);
        }

        try {
            console.log(`📥 Descargando sesión "${sessionName}" de Supabase...`);

            const { data, error } = await this.supabase.storage
                .from(this.bucketName)
                .download(`${sessionName}/session.zip`);

            if (error) {
                if (error.message.includes('Object not found')) {
                    console.log(`ℹ️  La sesión "${sessionName}" todavía no existe en la nube.`);
                    return null;
                }
                throw error;
            }

            const buffer = Buffer.from(await data.arrayBuffer());
            const folderPath = path.join(this.dataPath, sessionName);
            const tmpZipPath = path.join(os.tmpdir(), `wwebjs-down-${Date.now()}.zip`);
            fs.writeFileSync(tmpZipPath, buffer);

            // 1. Limpiar y extraer en la carpeta de sesión (Para nuestro uso manual)
            if (fs.existsSync(folderPath)) {
                try { fs.rmSync(folderPath, { recursive: true, force: true }); } catch (e) { }
            }
            fs.mkdirSync(folderPath, { recursive: true });
            await this._unzipDirectory(tmpZipPath, folderPath);
            console.log(`✅ Carpeta de sesión lista: ${folderPath}`);

            // 2. Manejar el ZIP que espera whatsapp-web.js
            // Guardamos en la ruta que nos pidió...
            if (targetPath.endsWith('.zip')) {
                fs.mkdirSync(path.dirname(targetPath), { recursive: true });
                if (fs.existsSync(targetPath) && fs.statSync(targetPath).isDirectory()) {
                    try { fs.rmSync(targetPath, { recursive: true, force: true }); } catch (e) { }
                }
                fs.writeFileSync(targetPath, buffer);
                console.log(`✅ ZIP guardado en: ${targetPath}`);

                // ... Y TAMBIÉN en la raíz por si la librería lo busca ahí (FALLBACK CRÍTICO)
                const fallbackPath = path.join(process.cwd(), path.basename(targetPath));
                if (fallbackPath !== targetPath) {
                    fs.writeFileSync(fallbackPath, buffer);
                    console.log(`✅ ZIP guardado (fallback): ${fallbackPath}`);
                }
            }

            try { if (fs.existsSync(tmpZipPath)) fs.unlinkSync(tmpZipPath); } catch (e) { }
            return targetPath;
        } catch (e) {
            console.error('❌ Error fatal extrayendo sesión:', e.message);
            return null;
        }
    }

    async delete(options) {
        const sessionName = options.session || 'default';

        try {
            const { error } = await this.supabase.storage
                .from(this.bucketName)
                .remove([`${sessionName}/session.zip`]);

            if (error) {
                throw error;
            }

            console.log(`🗑️  Sesión "${sessionName}" eliminada de Supabase`);
            return true;
        } catch (e) {
            console.error('❌ Error eliminando sesión:', e.message);
            return false;
        }
    }

    async _zipDirectory(sourceDir, outPath) {
        return new Promise((resolve, reject) => {
            const output = fs.createWriteStream(outPath);
            const archive = archiver('zip', { zlib: { level: 5 } });

            let filesAdded = 0;
            const blockedPatterns = [
                /Cache/i, /GPUCache/i, /Crashpad/i, /\.log$/i,
                /LOCK$/i, /\.tmp$/i, /blob_storage/i
            ];

            output.on('close', () => {
                console.log(`   ✅ Zip creado con ${filesAdded} archivos`);
                resolve();
            });

            archive.on('error', (err) => {
                // Ignorar errores EBUSY, continuar con otros archivos
                if (err.code === 'EBUSY' || err.code === 'EPERM') {
                    return;
                }
                console.error(`❌ Error fatal en archiver: ${err.message}`);
                reject(err);
            });

            archive.pipe(output);

            // Función recursiva para agregar archivos usando buffers
            const addFilesRecursively = (dir, baseDir) => {
                let entries;
                try {
                    entries = fs.readdirSync(dir, { withFileTypes: true });
                } catch (e) {
                    return;
                }

                for (const entry of entries) {
                    const fullPath = path.join(dir, entry.name);
                    const relativePath = path.relative(baseDir, fullPath);

                    // Verificar si el path coincide con patrones bloqueados
                    const isBlocked = blockedPatterns.some(p => p.test(relativePath));
                    if (isBlocked) continue;

                    if (entry.isDirectory()) {
                        addFilesRecursively(fullPath, baseDir);
                    } else {
                        try {
                            // Leer archivo completo en memoria (evita EBUSY en archiver)
                            const buffer = fs.readFileSync(fullPath);
                            // IMPORTANTE: Los ZIP deben usar '/' incluso en Windows
                            const zipName = relativePath.replace(/\\/g, '/');
                            archive.append(buffer, { name: zipName });
                            filesAdded++;
                        } catch (e) {
                            // Archivo bloqueado o inaccesible, omitir silenciosamente
                        }
                    }
                }
            };

            addFilesRecursively(sourceDir, sourceDir);
            archive.finalize();
        });
    }

    _unzipDirectory(zipPath, outPath) {
        return new Promise((resolve, reject) => {
            fs.mkdirSync(outPath, { recursive: true });
            fs.createReadStream(zipPath)
                .pipe(unzipper.Extract({ path: outPath }))
                .on('close', resolve)
                .on('error', reject);
        });
    }
}

module.exports = { SupabaseStore };
