require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
    console.error('❌ SUPABASE_URL or SUPABASE_KEY missing in .env');
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function resetDatabase() {
    console.log('🔄 Iniciando reset de base de datos para PRODUCCIÓN...');

    try {
        // Eliminar todos los jugadores (esto debería cascade a games si no hay circularidad, 
        // pero para estar seguro borramos ambos)

        console.log('🗑️  Borrando tabla de jugadores...');
        const { error: pError } = await supabase
            .from('players')
            .delete()
            .neq('id', 0); // Borrar todo

        if (pError) throw pError;

        console.log('🗑️  Borrando tabla de juegos...');
        const { error: gError } = await supabase
            .from('games')
            .delete()
            .neq('id', 0); // Borrar todo

        if (gError) throw gError;

        console.log('\n✅ BASE DE DATOS RESETEADA EXITOSAMENTE');
        console.log('✨ Listos para el lanzamiento oficial.');

    } catch (error) {
        console.error('❌ Error reseteando base de datos:', error.message);
        process.exit(1);
    }
}

resetDatabase();
