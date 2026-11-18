// SPDX-License-Identifier: BSD-3-Clause
import { test as base, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

export const threaded = process.env.AVOGADRO_WASM_KIT === "wasm_multithread";
const release = process.env.AVOGADRO_WASM_RELEASE;
const hookPackage = process.env.AVOGADRO_WASM_TEST_HOOKS;
const mimeTypes = {
  ".css": "text/css",
  ".html": "text/html",
  ".js": "text/javascript",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
};

async function startServer(handler) {
  const server = createServer(handler);
  await new Promise((done, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", done);
  });
  return {
    url: "http://127.0.0.1:" + server.address().port + "/",
    close: () => new Promise((done) => server.close(done)),
  };
}

async function servePackage(packagePath, isolated) {
  const root = resolve(packagePath);
  return startServer(async (request, response) => {
    if (isolated) {
      response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
      response.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
      response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    }
    const pathname = new URL(request.url, "http://localhost").pathname;
    const name = pathname === "/" ? "/index.html" : pathname;
    const assets = resolve(root, "." + name);
    if (!assets.startsWith(root + sep)) {
      response.writeHead(404).end();
      return;
    }
    try {
      const fixture = ["/core-fixture.html", "/core-fixture.js"].includes(name);
      const source = fixture
        ? new URL("../fixtures" + name, import.meta.url)
        : assets;
      response.setHeader(
        "Content-Type",
        mimeTypes[extname(name)] || "application/octet-stream",
      );
      response.end(await readFile(source));
    } catch {
      response.writeHead(404).end();
    }
  });
}

export const test = base.extend({
  releaseUrl: [
    async ({}, use) => {
      assert.ok(
        release,
        "Set AVOGADRO_WASM_RELEASE to the extracted release package directory",
      );
      const server = await servePackage(release, threaded);
      try {
        await use(server.url);
      } finally {
        await server.close();
      }
    },
    { scope: "worker" },
  ],
  hookUrl: [
    async ({}, use) => {
      const server = hookPackage
        ? await servePackage(hookPackage, threaded)
        : null;
      try {
        await use(server?.url);
      } finally {
        await server?.close();
      }
    },
    { scope: "worker" },
  ],
  serveWithoutIsolation: async ({}, use) => {
    const server = await servePackage(release, false);
    try {
      await use(server.url);
    } finally {
      await server.close();
    }
  },
  iframeUrl: async ({ releaseUrl }, use) => {
    const host = await startServer((_, response) => {
      response.setHeader("Content-Type", "text/html");
      response.end(
        '<!doctype html><iframe title="Avogadro viewport" width="760" height="520" src="' +
          releaseUrl +
          'core-fixture.html"></iframe>',
      );
    });
    try {
      await use(host.url);
    } finally {
      await host.close();
    }
  },
  offlineUrl: async ({}, use) => {
    if (threaded) {
      await use(null);
      return;
    }
    const directory = await mkdtemp(join(tmpdir(), "avogadro-offline-"));
    try {
      const page = join(directory, "avogadro-offline.html");
      await copyFile(join(release, "avogadro-offline.html"), page);
      await use(pathToFileURL(page).href);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  checkPageErrors: [
    async ({ page }, use) => {
      const errors = [];
      const violations = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.exposeBinding("recordTestCspViolation", (_, violation) => {
        violations.push(violation);
      });
      await page.addInitScript(() => {
        document.addEventListener("securitypolicyviolation", (event) => {
          void globalThis.recordTestCspViolation(
            event.violatedDirective + ": " + event.blockedURI,
          );
        });
      });
      await use();
      expect(errors, "Uncaught browser page errors").toEqual([]);
      expect(violations, "Content Security Policy violations").toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };

export async function openEditor(page, url) {
  await page.goto(url);
  await expect(page.locator("#controls")).toHaveJSProperty("disabled", false);
  await expect(
    page.locator("#qt-shadow-container canvas").first(),
  ).toBeVisible();
}

export async function openMolecule(page, name, text) {
  await page.locator("#file").setInputFiles({
    name,
    mimeType: "text/plain",
    buffer: Buffer.from(text),
  });
  await expect(page.locator("#document-name")).toHaveText(name);
}

export async function exportMolecule(page, format) {
  await page.locator("#export-toggle").click();
  await page.locator("#format").selectOption(format);
  const downloading = page.waitForEvent("download");
  await page.locator("#download").click();
  const download = await downloading;
  const chunks = [];
  for await (const chunk of await download.createReadStream())
    chunks.push(chunk);
  return {
    name: download.suggestedFilename(),
    text: Buffer.concat(chunks).toString("utf8"),
  };
}
