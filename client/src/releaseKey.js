'use strict';

// ============== CLAVE PÚBLICA DE FIRMA DE RELEASES (Fase B5) ==============
// Ed25519. Se usa para verificar la firma de SHA256SUMS que CI publica junto
// a cada release (ver docs/release-signing.md y client/scripts/sign-release.js).
// La clave PRIVADA correspondiente NUNCA vive en este repo: solo existe como
// el secret RELEASE_SIGNING_KEY en GitHub Actions. Esta pública se generó una
// sola vez con client/scripts/generate-release-key.js.
const RELEASE_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEArAHO+1hxOIg8p4pEzSARJGJI5qVkzRsW8B2hy3tZ8zQ=
-----END PUBLIC KEY-----
`;

module.exports = { RELEASE_PUBLIC_KEY_PEM };
