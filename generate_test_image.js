const puppeteer = require('puppeteer');
const path = require('path');

(async () => {
    const browser = await puppeteer.launch({
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
        headless: true
    });
    const page = await browser.newPage();

    // Set viewport to a reasonable size for the summary, perhaps similar to what the bot uses (default 800x600 might be small, let's try bigger)
    // Or since we want a screenshot of the element, we can set a large viewport and clip later if needed.
    // The HTML has a max-w-5xl (1024px) container, plus padding.
    await page.setViewport({ width: 1200, height: 1000 });

    const htmlPath = path.resolve(__dirname, 'match_summary.html');
    await page.goto(`file://${htmlPath}`, { waitUntil: 'networkidle0' });

    // Select the glass panel to screenshot, or the body? The user mentioned a scrollbar in the png.
    // If the screenshot logic in the original bot takes a screenshot of the body or full page, the scrollbar would appear if content overflowed.
    // Let's screenshot the body to see if the scrollbar is gone.
    await page.screenshot({ path: 'match_summary_test.png', fullPage: true });

    await browser.close();
    console.log('Test image generated at match_summary_test.png');
})();
