'use strict';

// ============== GENERADOR DE CLAVE DE FIRMA DE RELEASES (Fase B5) ==============
// Se corre UNA VEZ (a mano, nunca en CI) para crear el par de claves Ed25519
// que firma dist/SHA256SUMS en cada release. Ver docs/release-signing.md.
//
// Uso:
//   node client/scripts/generate-release-key.js [ruta-de-salida]
//
// La clave PRIVADA se escribe en la ruta indicada (por defecto
// release-signing.key en el directorio actual) y NUNCA debe subirse al repo
// (está en .gitignore) ni pegarse en un chat/PR: solo vive como el secret
// RELEASE_SIGNING_KEY en GitHub Actions. La clave PÚBLICA se imprime en
// consola para pegarla en client/src/releaseKey.js.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function generate() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    return { publicPem, privatePem };
}

function main(argv = process.argv.slice(2)) {
    const outFile = path.resolve(argv[0] || 'release-signing.key');
    const { publicPem, privatePem } = generate();

    fs.writeFileSync(outFile, privatePem, { mode: 0o600 });

    console.log(`Clave privada escrita en: ${outFile}`);
    console.log('NO la subas al repo, ni la pegues en un chat/PR/issue.');
    console.log('Súbela como el secret RELEASE_SIGNING_KEY en GitHub → Settings → Secrets and variables → Actions.');
    console.log('\nClave pública (pégala tal cual en client/src/releaseKey.js, como RELEASE_PUBLIC_KEY_PEM):\n');
    console.log(publicPem);

    return { outFile, publicPem };
}

if (require.main === module) main();

module.exports = { generate, main };
