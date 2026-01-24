const { LocalAuth } = require('whatsapp-web.js');
const path = require('path');

const authPath = path.join(__dirname, '.wwebjs_auth_test');
const auth = new LocalAuth({ dataPath: authPath });

console.log('Auth dataPath:', auth.dataPath);
console.log('Auth clientId:', auth.clientId);
// Inspect internal property if possible or assume logic
// In v1.23+ LocalAuth usually has userDataDir property after init?
// Let's just print the object
console.log(auth);
