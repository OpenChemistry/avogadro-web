// SPDX-License-Identifier: BSD-3-Clause
// Deterministic import smoke tests using small ordinary molecule fixtures.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";

const { default: puppeteer } = await import(
  process.env.PUPPETEER_MODULE || "puppeteer-core"
);
const packagePath = resolve(process.argv[2]);
const threaded = process.argv.includes("--threaded");
const rounds = process.argv.includes("--nightly") ? 15 : 1;
const contentTypes = {
  html: "text/html",
  js: "text/javascript",
  wasm: "application/wasm",
};
const server = createServer(async (request, response) => {
  if (threaded) {
    response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    response.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  }
  const pathname = new URL(request.url, "http://localhost").pathname;
  const fixture = ["/core-fixture.html", "/core-fixture.js"].includes(pathname);
  const asset = resolve(packagePath, "." + pathname);
  if (!asset.startsWith(packagePath + sep)) {
    response.writeHead(404).end();
    return;
  }
  try {
    response.setHeader(
      "Content-Type",
      contentTypes[pathname.split(".").at(-1)] || "application/octet-stream",
    );
    const source = fixture
      ? new URL("./fixtures" + pathname, import.meta.url)
      : asset;
    response.end(await readFile(source));
  } catch {
    response.writeHead(404).end();
  }
});

await new Promise((done) => server.listen(0, "127.0.0.1", done));
let browser;
try {
  browser = await puppeteer.launch({
    executablePath: process.env.CHROME_BINARY || "/usr/bin/google-chrome",
    args: [
      "--no-sandbox",
      "--enable-unsafe-swiftshader",
      "--use-angle=swiftshader",
    ],
  });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(
    "http://127.0.0.1:" + server.address().port + "/core-fixture.html",
  );
  await page.waitForFunction(() => !!globalThis.coreReady);
  const result = await page.evaluate(async (rounds) => {
    const editor = await globalThis.coreReady;
    const fixtures = [
      "2\nHydrogen\nH 0 0 0\nH 0 0 0.74\n",
      "3\nWater\nO 0 0 0\nH 0.96 0 0\nH -0.24 0.93 0\n",
      "2\nCarbon monoxide\nC 0 0 0\nO 0 0 1.13\n",
    ];
    let attempts = 0;
    for (let round = 0; round < rounds; round++) {
      for (const fixture of fixtures) {
        editor.loadMolecule(fixture, "xyz");
        const original = JSON.parse(editor.exportMolecule()).atoms.elements
          .number;
        for (const format of ["cjson", "mol", "sdf", "xyz"]) {
          const exported = editor.exportMolecule(format);
          editor.loadMolecule(exported, format);
          const before = editor.exportMolecule();
          const elements = JSON.parse(before).atoms.elements.number;
          if (JSON.stringify(elements) !== JSON.stringify(original))
            throw new Error("Changed element sequence through " + format);

          for (const text of ["", "A plain text note."]) {
            let rejected = false;
            try {
              editor.loadMolecule(text, format);
            } catch {
              rejected = true;
            }
            if (!rejected || editor.exportMolecule() !== before)
              throw new Error("Import changed the document for " + format);
            attempts++;
          }
        }
      }
    }
    return { attempts, isolated: globalThis.crossOriginIsolated };
  }, rounds);
  assert.equal(result.attempts, rounds * 3 * 4 * 2);
  assert.equal(result.isolated, threaded);
  assert.deepEqual(errors, []);
  console.log(
    "Passed %d bounded rejected-import cases and their valid round trips",
    result.attempts,
  );
} finally {
  if (browser) await browser.close();
  await new Promise((done) => server.close(done));
}
