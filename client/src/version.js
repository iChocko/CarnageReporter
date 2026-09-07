'use strict';

// Fuente única de la versión: client/package.json. pkg detecta este require
// literal en tiempo de build y empaqueta el package.json en el snapshot, así
// que también funciona en el .exe.
const { version } = require('../package.json');

module.exports = { VERSION: version };
