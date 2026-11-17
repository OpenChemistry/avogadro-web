// SPDX-License-Identifier: BSD-3-Clause
// Run: PUPPETEER_MODULE=... node startup-failures.mjs STAGED_DIRECTORY [--single-threaded]
// Owns loopback servers and a fresh headless Chrome profile.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
const { default: puppeteer } = await import(process.env.PUPPETEER_MODULE || 'puppeteer-core');
const directory = resolve(process.argv[2]);
const singleThreaded = process.argv.includes('--single-threaded');
let scenario;
const origin = () => `http://127.0.0.1:${server.address().port}`;
const server = createServer(async (request, response) => {
  if (!singleThreaded && scenario !== 'isolation') {
    response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  }
  const pathname = new URL(request.url, 'http://localhost').pathname;
  const name = pathname === '/' ? '/index.html' : pathname;
  const fixture = ['/core-fixture.html', '/core-fixture.js'].includes(name);
  const path = resolve(directory, `.${name}`);
  if (!path.startsWith(directory + sep)) {
    response.writeHead(404).end();
    return;
  }
  const types = { js: 'text/javascript', wasm: 'application/wasm', css: 'text/css', html: 'text/html' };
  response.setHeader('Content-Type', types[name.split('.').pop()] || 'text/plain');
  try {
    if (scenario === 'missing-wasm' && name.endsWith('.wasm')) throw new Error('intentionally absent');
    const asset = fixture ? new URL(`./fixtures${name}`, import.meta.url) : path;
    response.end(await readFile(asset));
  } catch { response.statusCode = 404; response.end('Missing asset'); }
});
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const close = server => new Promise(resolve => server.close(resolve));
await listen(server);
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_BINARY || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader'] });
let parent;
try {
  const corePage = await browser.newPage();
  const coreUrl = `${origin()}/core-fixture.html`;
  let core = corePage;
  if (singleThreaded) {
    parent = createServer((_request, response) => {
      response.setHeader('Content-Type', 'text/html');
      response.end(`<!doctype html><iframe src="${coreUrl}" title="Avogadro viewport" width="760" height="520"></iframe>`);
    });
    await listen(parent);
    await corePage.goto(`http://127.0.0.1:${parent.address().port}`);
    core = await (await corePage.waitForSelector('iframe')).contentFrame();
    assert.ok(core);
    assert.equal(core.url(), coreUrl);
    assert.notEqual(new URL(corePage.url()).origin, new URL(core.url()).origin);
  } else {
    await corePage.goto(coreUrl);
  }
  await core.waitForFunction(() => !!globalThis.coreReady);
  assert.equal(await core.evaluate(() => globalThis.crossOriginIsolated), !singleThreaded);
  const elements = await core.evaluate(async () => {
    const editor = await globalThis.coreReady;
    editor.addEventListener('statechange', event => { globalThis.coreState = event.detail; });
    editor.loadMolecule('3\nWater\nO 0 0 0\nH 0.96 0 0\nH -0.24 0.93 0\n', 'xyz');
    return JSON.parse(editor.exportMolecule()).atoms.elements.number;
  });
  assert.deepEqual(elements, [8, 1, 1]);
  await core.waitForFunction(() => globalThis.coreState?.atomCount === 3 &&
    globalThis.coreState?.bondCount === 2);
  const canvasWidth = () => document.querySelector('#qt-shadow-container')?.shadowRoot
    ?.querySelector('canvas')?.clientWidth;
  await core.waitForFunction(canvasWidth);
  const initialWidth = await core.evaluate(canvasWidth);
  await core.$eval('#viewport', viewport => { viewport.style.width = '480px'; });
  await core.waitForFunction(width =>
    document.querySelector('#qt-shadow-container')?.shadowRoot
      ?.querySelector('canvas')?.clientWidth === width, {}, initialWidth - 160);
  console.log(`PASS: core startup, molecule round trip, statechange and resize (${singleThreaded ? 'cross-origin iframe without isolation' : 'isolated page'})`);
  await corePage.close();

  if (singleThreaded) {
    const page = await browser.newPage();
    await page.goto(origin());
    await page.waitForFunction(() => !document.querySelector('#controls').disabled);
    assert.equal(await page.evaluate(() => globalThis.crossOriginIsolated), false);
    assert.equal(await page.$eval('#calculations', el => el.hidden), true);
    assert.equal(await page.$eval('#calculation-unavailable', el => el.hidden), false);
    assert.equal(await page.evaluate(() => !!document.querySelector('#tools [data-tool="AutoOpt"]')), false);
    console.log('PASS: single-threaded editor starts without isolation and hides worker-based calculations');
    await page.close();
  }

  const failures = [['webgl', 'WebGL 2 is unavailable'], ['missing-wasm', 'wasm']];
  if (!singleThreaded) failures.unshift(['isolation', 'cross-origin isolation']);
  for (const [name, expected] of failures) {
    scenario = name;
    const page = await browser.newPage();
    if (name === 'webgl') await page.evaluateOnNewDocument(() => { const get = HTMLCanvasElement.prototype.getContext; HTMLCanvasElement.prototype.getContext = function(type, ...args) { return type === 'webgl2' ? null : get.call(this, type, ...args); }; });
    await page.goto(origin());
    await page.waitForFunction(() => document.querySelector('#status').textContent === 'The editor could not start.', { timeout: 30000 });
    assert.equal(await page.$eval('#controls', el => el.disabled), true);
    assert.ok((await page.$eval('#loading', el => el.textContent)).toLowerCase().includes(expected.toLowerCase()));
    console.log(`PASS: visible startup failure for ${name}`);
    await page.close();
  }
} finally {
  await browser.close();
  if (parent) await close(parent);
  await close(server);
}
