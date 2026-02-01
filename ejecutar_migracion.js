/**
 * Script para ejecutar migración directa usando Supabase REST API
 */

require('dotenv').config({ path: './server/.env' });
const https = require('https');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const SQL_STATEMENTS = [
    `ALTER TABLE public.games ADD COLUMN IF NOT EXISTS duration INTEGER DEFAULT 0`,
    `ALTER TABLE public.games ADD COLUMN IF NOT EXISTS playlist_name VARCHAR(255)`,
    `ALTER TABLE public.players ADD COLUMN IF NOT EXISTS player_index INTEGER DEFAULT 0`,
    `ALTER TABLE public.players ADD COLUMN IF NOT EXISTS kd_ratio NUMERIC(5,2) DEFAULT 0`
];

console.log('╔══════════════════════════════════════════════════════════╗');
console.log('║      EJECUTANDO MIGRACIÓN DE BASE DE DATOS              ║');
console.log('╚══════════════════════════════════════════════════════════╝\n');

async function executeSQL(sql) {
    return new Promise((resolve, reject) => {
        const url = new URL('/rest/v1/rpc/exec_sql', SUPABASE_URL);

        const postData = JSON.stringify({ query: sql });

        const options = {
            hostname: url.hostname,
            path: url.pathname,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'apikey': SUPABASE_KEY,
                'Authorization': `Bearer ${SUPABASE_KEY}`,
                'Content-Length': Buffer.byteLength(postData)
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    resolve({ success: true, data });
                } else {
                    resolve({ success: false, status: res.statusCode, data });
                }
            });
        });

        req.on('error', (error) => reject(error));
        req.write(postData);
        req.end();
    });
}

async function runMigration() {
    console.log('📝 Migraciones a ejecutar:\n');

    for (let i = 0; i < SQL_STATEMENTS.length; i++) {
        const sql = SQL_STATEMENTS[i];
        console.log(`${i + 1}. ${sql.substring(0, 60)}...`);
    }

    console.log('\n⏳ Ejecutando...\n');

    // Dado que Supabase no expone exec_sql por defecto, 
    // usaremos el enfoque de verificación de columnas
    console.log('⚠️  NOTA: La API REST de Supabase no permite ejecutar DDL arbitrario.');
    console.log('   Usaremos una verificación alternativa.\n');

    console.log('🔧 Para ejecutar la migración, copia y pega en Supabase SQL Editor:\n');
    console.log('═'.repeat(60));
    SQL_STATEMENTS.forEach((sql, i) => {
        console.log(`${sql};`);
    });
    console.log('═'.repeat(60));
    console.log('\n📍 URL: https://supabase.com/dashboard/project/isxjfvrdnmrwxyzfbvua/sql/new\n');

    console.log('✅ Una vez ejecutada la migración, el código actualizado ya está listo.');
    console.log('   Ejecuta una prueba de envío para verificar que todo funcione.\n');
}

runMigration().catch(console.error);
