// SPDX-License-Identifier: BSD-3-Clause
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

export const origin = 'https://editor.example';
export const pubchem = 'https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound';
export const sdf = `Methane
  fixture          3D

  1  0  0  0  0  0  0  0  0  0999 V2000
    0.0000    0.0000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0
M  END
$$$$
`;
export const xyz = '1\nHelium\nHe 0 0 0\n';

const { default: puppeteer } = await import(process.env.PUPPETEER_MODULE || 'puppeteer-core');
const contentTypes = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.wasm': 'application/wasm', '.svg': 'image/svg+xml' };

export async function openFixture(directory, routes) {
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME_BINARY || '/usr/bin/google-chrome',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader', '--use-angle=swiftshader'],
  });
  const page = await browser.newPage();
  const requestErrors = [];
  const violations = [];
  await page.setViewport({ width: 1200, height: 800 });
  await page.evaluateOnNewDocument(() => {
    window.cspViolations = [];
    document.addEventListener('securitypolicyviolation', event => window.cspViolations.push(event.effectiveDirective));
  });
  page.on('pageerror', error => violations.push(error.message));
  await page.setRequestInterception(true);
  page.on('request', async request => {
    const url = new URL(request.url());
    if (url.protocol === 'data:' || url.protocol === 'blob:') return;
    try {
      const respond = options => request.respond({ ...options, headers: {
        'access-control-allow-origin': '*', ...(options.headers || {}),
      } });
      const route = routes.get(url.href);
      if (route) {
        await route(request, respond);
      } else if (url.origin === origin) {
        const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
        const contentType = contentTypes[extname(name)];
        if (!contentType) return await request.respond({ status: 404 });
        const body = await readFile(join(directory, name));
        await request.respond({ status: 200, contentType, body });
      } else if (!request.isInterceptResolutionHandled()) {
        requestErrors.push(url.href);
        await request.abort();
      }
    } catch (error) {
      requestErrors.push(error.message);
      if (!request.isInterceptResolutionHandled()) await request.abort();
    }
  });
  async function go(path = '/') {
    await page.goto(origin + path);
    await page.waitForFunction(() => !document.getElementById('controls').disabled);
  }
  const waitText = (id, text) => page.waitForFunction((id, text) =>
    document.getElementById(id)?.textContent.includes(text), {}, id, text);
  return { browser, page, go, waitText, requestErrors, violations };
}
