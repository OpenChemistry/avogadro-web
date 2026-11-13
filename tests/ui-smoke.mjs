// SPDX-License-Identifier: BSD-3-Clause
// PUPPETEER_MODULE=... node tests/ui-smoke.mjs URL EVIDENCE_DIRECTORY
// Uses a fresh browser profile and the real supplied WASM runtime.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
const { default: puppeteer } = await import(process.env.PUPPETEER_MODULE || 'puppeteer-core');
const url = process.argv[2] || 'http://127.0.0.1:8766';
const output = resolve(process.argv[3] || 'ui-evidence');
await mkdir(output, { recursive: true });
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_BINARY || '/usr/bin/google-chrome', headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader', '--use-angle=swiftshader'] });
const checks = [], errors = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
  const page = await browser.newPage();
  page.on('pageerror', e => errors.push(e.message));
  // Observe the public runtime boundary without replacing molecular operations.
  await page.setRequestInterception(true);
  page.on('request', async request => {
    if (!request.url().endsWith('/qtloader.js')) return request.continue();
    const response = await fetch(request.url());
    const source = await response.text();
    await request.respond({ status: 200, contentType: 'text/javascript', body: source + `
      const originalQtLoad = qtLoad;
      qtLoad = async options => {
        window.testExit = options.qt.onExit;
        const instance = await originalQtLoad(options);
        window.testRuntime = instance;
        return instance;
      };
    ` });
  });
  const ready = () => page.waitForFunction(() => !document.querySelector('#controls').disabled, { timeout: 90000 });
  const capture = async name => { await delay(150); await page.screenshot({ path: join(output, `${name}.png`) }); };
  const noOverflow = async () => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(url); await ready();
  assert.equal(await page.$eval('html', el => el.dataset.theme), 'dark');
  if (process.argv.includes('--full-runtime')) {
    const capabilities = await page.evaluate(() => {
      const state = JSON.parse(testRuntime.editorState());
      return { tools: state.tools.length, styles: state.displayStyles.length,
        optimize: state.canOptimize, surfaces: state.canRenderSurfaces,
        theme: typeof testRuntime.setTheme === 'function' };
    });
    assert.deepEqual(capabilities, { tools: 9, styles: 6, optimize: true, surfaces: true, theme: true });
    assert.equal(await page.$eval('body', el => el.classList.contains('runtime-fixed-canvas')), false);
    checks.push('Full runtime exposes nine tools, six display styles, calculations and canvas themes');
  }
  await capture('dark-empty-1440');
  await page.click('#theme');
  await capture('light-empty-1440');
  await page.reload(); await ready();
  assert.equal(await page.$eval('html', el => el.dataset.theme), 'light');
  checks.push('Dark default, light toggle and persistence across reload');
  const box = await page.$eval('#viewport', el => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  await page.mouse.click(box.x, box.y);
  await page.waitForFunction(() => document.querySelector('#counts').textContent.startsWith('5 atoms'));
  const snapshot = () => page.evaluate(() => ({ state: JSON.parse(testRuntime.editorState()), molecule: testRuntime.exportMolecule('cjson') }));
  const before = await snapshot();
  await page.click('#theme');
  assert.deepEqual(await snapshot(), before);
  checks.push('Theme switching leaves molecule, modified state and undo history unchanged');
  for (const [width, height] of [[1440, 900], [1024, 768], [768, 1024]]) {
    await page.setViewport({ width, height });
    if (width < 1000) await page.evaluate(() => { if (document.querySelector('#inspector-toggle').getAttribute('aria-expanded') === 'true') document.querySelector('#inspector-close').click(); });
    for (const theme of ['dark', 'light']) {
      if (await page.$eval('html', el => el.dataset.theme) !== theme) await page.click('#theme');
      await noOverflow(); await capture(`${theme}-molecule-${width}`);
    }
  }
  await page.click('#inspector-toggle');
  await page.click('#tab-tool'); await page.focus('#tab-tool');
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.$eval('#tab-display', el => el.getAttribute('aria-selected')), 'true');
  await capture('light-drawer-768');
  await page.keyboard.press('Escape');
  assert.equal(await page.$eval('#inspector-toggle', el => el.getAttribute('aria-expanded')), 'false');
  checks.push('Responsive layouts, drawer closing and keyboard tab navigation');
  await page.setViewport({ width: 1440, height: 900 });
  await page.click('#inspector-toggle');
  const wide = await page.$eval('#viewport', el => el.clientWidth);
  await page.click('#inspector-close');
  await page.waitForFunction(w => document.querySelector('#viewport').clientWidth > w, {}, wide);
  await page.click('#inspector-toggle');
  checks.push('Inspector collapse resizes the live viewport');
  await page.click('#export-toggle');
  assert.equal(await page.$eval('#export-menu', el => el.hidden), false);
  await page.keyboard.press('Escape');
  assert.equal(await page.$eval('#export-menu', el => el.hidden), true);
  await page.click('#new');
  await page.waitForSelector('#discard-dialog[open]'); await capture('unsaved-confirmation');
  await page.keyboard.press('Escape');
  assert.deepEqual(await snapshot(), before);
  checks.push('Export popover keyboard dismissal and canceled replacement preserve the document');
  if (process.env.AVOGADRO_UI_FIXTURE) {
    await (await page.$('#file')).uploadFile(process.env.AVOGADRO_UI_FIXTURE);
    await page.waitForSelector('#discard-dialog[open]');
    await page.click('[value="discard"]');
    await page.waitForFunction(() => document.querySelector('#counts').textContent !== '5 atoms · 4 bonds');
    await page.click('#tab-tool');
    for (const theme of ['dark', 'light']) {
      if (await page.$eval('html', el => el.dataset.theme) !== theme) await page.click('#theme');
      await capture(`${theme}-caffeine`);
      if (process.argv.includes('--full-runtime')) {
        await page.click('#tab-display');
        await page.click('[data-style="Label"]');
        await capture(`${theme}-labels`);
        await page.click('[data-style="Label"]');
        await page.click('#tab-tool');
      }
    }
  }
  await page.evaluate(() => testExit({ text: 'Test runtime exit' }));
  assert.equal(await page.$eval('#controls', el => el.disabled), true);
  assert.equal(await page.$eval('#document-controls', el => el.disabled), true);
  assert.equal(await page.$eval('#viewport', el => el.inert), true);
  checks.push('Runtime exit disables both control groups and the viewport');
  await page.close();
  // Hold the WASM response to inspect loading, then force startup failure.
  for (const theme of ['dark', 'light']) {
    const loading = await browser.newPage();
    await loading.setViewport({ width: 1024, height: 768 });
    await loading.evaluateOnNewDocument(t => localStorage.setItem('avogadro-theme', t), theme);
    await loading.setRequestInterception(true);
    let wasm, failWasm = false;
    loading.on('request', request => {
      if (request.url().endsWith('.wasm')) { if (failWasm) request.abort(); else wasm = request; }
      else request.continue();
    });
    await loading.goto(url, { waitUntil: 'domcontentloaded' });
    await loading.waitForSelector('.spinner');
    assert.equal(await loading.$eval('#controls', el => el.disabled), true);
    assert.equal(await loading.$eval('#document-controls', el => el.disabled), true);
    await loading.screenshot({ path: join(output, `${theme}-loading.png`) });
    for (let i = 0; !wasm && i < 100; i++) await delay(50);
    assert.ok(wasm); failWasm = true; await wasm.abort();
    await loading.waitForSelector('#loading[data-error="true"]');
    await loading.screenshot({ path: join(output, `${theme}-startup-error.png`) });
    await loading.close();
  }
  checks.push('Loading and startup failure remain legible and disable document actions in both themes');
  assert.deepEqual(errors, []);
  await writeFile(join(output, 'results.json'), JSON.stringify({ checks, errors }, null, 2));
  console.log(checks.map(c => `PASS: ${c}`).join('\n'));
} finally { await browser.close(); }
