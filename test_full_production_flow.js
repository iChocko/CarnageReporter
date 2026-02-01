/**
 * Prueba de Flujo Completo Realista - PRODUCCIÓN
 * 1. Monitorea archivos en tiempo real
 * 2. Genera 2 partidas competitivas con datos realistas
 * 3. Las envía al servidor de producción h3mccstats.cloud
 */

const MCCClient = require('./client/simulator');
const MatchGenerator = require('./client/match_generator');
const fs = require('fs');
const path = require('path');

async function runProductionSimulation() {
    console.log('🚀 INICIANDO SIMULACIÓN DE FLUJO COMPLETO EN PRODUCCIÓN\n');

    // Directorio temporal coordinado
    const tempPath = path.join(__dirname, 'client', 'temp');
    if (!fs.existsSync(tempPath)) fs.mkdirSync(tempPath, { recursive: true });

    // Configurar cliente para PRODUCCIÓN
    const client = new MCCClient({
        tempDir: tempPath,
        serverHost: 'h3mccstats.cloud',
        serverPort: 443,
        useHttps: true,
        apiKey: 'h3mcc-carnage-2024-secret'
    });

    try {
        // 1. Iniciar cliente
        await client.init();
        client.startMonitoring();

        console.log('\n--- 🕒 Jugando Partida 1... ---');
        await new Promise(resolve => setTimeout(resolve, 3000));

        // Generar partida 1 (Competitiva)
        const game1 = MatchGenerator.generateMatch(1, true);

        const file1 = path.join(tempPath, `match_1_${Date.now()}.json`);
        fs.writeFileSync(file1, JSON.stringify(game1, null, 2));
        console.log(`📡 Archivo de Partida 1 generado: ${path.basename(file1)}`);

        // Esperar a que el cliente la procese
        await new Promise(resolve => setTimeout(resolve, 5000));

        console.log('\n--- 🕒 Jugando Partida 2... ---');
        await new Promise(resolve => setTimeout(resolve, 3000));

        // Generar partida 2 (Competitiva)
        const game2 = MatchGenerator.generateMatch(2, true);

        const file2 = path.join(tempPath, `match_2_${Date.now()}.json`);
        fs.writeFileSync(file2, JSON.stringify(game2, null, 2));
        console.log(`📡 Archivo de Partida 2 generado: ${path.basename(file2)}`);

        // Esperar a que el cliente la procese
        await new Promise(resolve => setTimeout(resolve, 10000));

        // 2. Finalizar
        client.stopMonitoring();
        client.showStats();

        console.log('\n✅ SIMULACIÓN FINALIZADA');
        console.log('🔗 Ahora verifica h3mccstats.cloud para ver los cambios.');

    } catch (error) {
        console.error('❌ Error en la simulación:', error);
        process.exit(1);
    }
}

runProductionSimulation();
