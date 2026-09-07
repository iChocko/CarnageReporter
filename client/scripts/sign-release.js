'use strict';

// ============== FIRMA DE RELEASES (Fase B5) ==============
// Corre en CI (.github/workflows/build-and-release.yml) después de generar
// dist/SHA256SUMS: firma esos bytes exactos con Ed25519 y escribe
// dist/SHA256SUMS.sig (base64). El cliente (client/src/updater.js) verifica
// esa firma con la clave pública embebida en client/src/releaseKey.js antes
// de aplicar cualquier actualización. Ver docs/release-signing.md.
//
// Uso:
//   RELEASE_SIGNING_KEY="<pem de la clave privada>" node client/scripts/sign-release.js [ruta/a/SHA256SUMS]

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function signFile(sumsPath, privateKeyPem) {
    const data = fs.readFileSync(sumsPath);
    const privateKey = crypto.createPrivateKey(privateKeyPem);
    const signature = crypto.sign(null, data, privateKey);
    const sigPath = `${sumsPath}.sig`;
    fs.writeFileSync(sigPath, signature.toString('base64'));
    return sigPath;
}

function main(argv = process.argv.slice(2)) {
    const sumsPath = path.resolve(argv[0] || path.join('dist', 'SHA256SUMS'));
    const privateKeyPem = process.env.RELEASE_SIGNING_KEY;

    if (!privateKeyPem) {
        console.error('Falta el secret/variable RELEASE_SIGNING_KEY (PEM de la clave privada Ed25519). Ver docs/release-signing.md.');
        process.exitCode = 1;
        return false;
    }
    if (!fs.existsSync(sumsPath)) {
        console.error(`No se encontró ${sumsPath}. Genera SHA256SUMS antes de firmar.`);
        process.exitCode = 1;
        return false;
    }

    const sigPath = signFile(sumsPath, privateKeyPem);
    console.log(`Firmado: ${sigPath}`);
    return true;
}

if (require.main === module) main();

module.exports = { signFile, main };
