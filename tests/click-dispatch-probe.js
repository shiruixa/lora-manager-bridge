/**
 * Where does a click go when the pressed element is removed mid-press?
 * Real input events via CDP, not synthesized dispatchEvent.
 */
const pup = require('C:/Users/ASUS/AppData/Local/npm-cache/_npx/23232c69e5d221f3/node_modules/puppeteer-core');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const b = await pup.launch({
    executablePath: 'C:/Users/ASUS/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe',
    headless: true, args: ['--no-sandbox'],
  });
  const page = await b.newPage();
  await page.setContent(`<!DOCTYPE html><html><body>
    <div id="wrap"><button id="btn" style="width:200px;height:40px">download</button></div>
  </body></html>`);

  await page.evaluate(() => {
    window.__seen = [];
    document.addEventListener('click', (e) => {
      window.__seen.push('document:' + (e.target.id || e.target.className || e.target.tagName));
    }, true);
    document.getElementById('wrap').addEventListener('click', () => window.__seen.push('wrap'));
  });

  const box = await page.evaluate(() => {
    const r = document.getElementById('btn').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });

  // Case 1: press and release on the same node.
  await page.mouse.move(box.x, box.y);
  await page.mouse.down(); await page.mouse.up();
  await sleep(100);
  console.log('  case 1 (same node)        :', JSON.stringify(await page.evaluate(() => window.__seen)));

  // Case 2: the node is replaced between press and release.
  await page.evaluate(() => { window.__seen = []; });
  await page.mouse.move(box.x, box.y);
  await page.mouse.down();
  await page.evaluate(() => {
    const old = document.getElementById('btn');
    const fresh = document.createElement('button');
    fresh.id = 'btn2';
    fresh.style.cssText = 'width:200px;height:40px';
    fresh.textContent = 'download';
    old.replaceWith(fresh);
  });
  await page.mouse.up();
  await sleep(100);
  console.log('  case 2 (replaced mid-press):', JSON.stringify(await page.evaluate(() => window.__seen)));

  await b.close();
})();
