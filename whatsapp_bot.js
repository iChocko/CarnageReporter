const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const path = require('path');
const fs = require('fs');

console.log('Starting WhatsApp Bot...');

// Path to the match summary image
const imagePath = path.resolve(__dirname, 'match_summary.png');
const targetGroupName = 'H3MCC';

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
        headless: true
    }
});

console.log('Client created, waiting for events...');

client.on('qr', (qr) => {
    console.log('\n\n--- SCAN THE QR CODE BELOW ---\n');
    qrcode.generate(qr, { small: true });
    console.log('\n');
});

client.on('authenticated', () => {
    console.log('Authenticated successfully!');
});

client.on('ready', async () => {
    console.log('WhatsApp Client is ready!');

    try {
        console.log('Fetching chats...');
        const chats = await client.getChats();
        console.log(`Total chats found: ${chats.length}`);

        const group = chats.find(chat => chat.isGroup && chat.name === targetGroupName);

        if (group) {
            console.log(`Group found: ${group.name} (${group.id._serialized})`);

            if (fs.existsSync(imagePath)) {
                console.log('Reading image file...');
                const media = MessageMedia.fromFilePath(imagePath);
                console.log(`Media loaded: ${media.mimetype}`);

                console.log('Attempting to send with WAMessageStubType workaround...');
                // Patch the internal sendSeen method to avoid the error
                await client.pupPage.evaluate(() => {
                    window.WWebJS.sendSeen = async () => { return true; };
                });

                console.log('Sending message...');
                await client.sendMessage(group.id._serialized, media, {
                    caption: '🎮 Halo 3 Match Summary - Carnage Reporter'
                });

                console.log('✅ Match summary PNG sent successfully!');
            } else {
                console.error('Error: match_summary.png not found at', imagePath);
            }
        } else {
            console.error(`Error: Group "${targetGroupName}" not found.`);
            console.log('\nAvailable groups:');
            chats.filter(chat => chat.isGroup).forEach(g => console.log(`  - ${g.name}`));
        }
    } catch (error) {
        console.error('Error in ready handler:', error);
    }
});

client.on('loading_screen', (percent, message) => {
    console.log('LOADING SCREEN', percent, message);
});

client.on('auth_failure', msg => {
    console.error('Authentication failed', msg);
});

client.on('disconnected', (reason) => {
    console.log('Client was disconnected', reason);
});

console.log('Initializing client...');
client.initialize();
