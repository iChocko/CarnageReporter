
const { createClient } = require('@supabase/supabase-js');
const { execSync } = require('child_process');

const supabaseUrl = 'https://isxjfvrdnmrwxyzfbvua.supabase.co';
const supabaseKey = 'sb_secret_bgUkXG9EjVga3lIy8k-StA_W_I6VDGa'; // From deploy.sh

async function checkSupabase() {
    console.log('Testing Supabase connection...');
    try {
        const client = createClient(supabaseUrl, supabaseKey);
        const { data, error } = await client.from('games').select('count', { count: 'exact', head: true });
        
        if (error) {
            console.error('❌ Supabase Error:', error.message);
        } else {
            console.log('✅ Supabase Connection OK. Games count available.');
        }
    } catch (e) {
        console.error('❌ Supabase Exception:', e.message);
    }
}

function checkPkg() {
    console.log('\nChecking pkg (for building exe)...');
    try {
        execSync('npx pkg --version', { stdio: 'ignore' });
        console.log('✅ pkg is available via npx.');
    } catch (e) {
        console.log('⚠️  pkg not found via npx. It might need to be installed globally or as a dev dependency.');
    }
}

async function main() {
    await checkSupabase();
    checkPkg();
}

main();
