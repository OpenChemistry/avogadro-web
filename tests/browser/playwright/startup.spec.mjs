// SPDX-License-Identifier: BSD-3-Clause
import { expect, openEditor, test, threaded } from "./packages.mjs";

const water = "3\nWater\nO 0 0 0\nH 0.96 0 0\nH -0.24 0.93 0\n";
const canvas = "#qt-shadow-container canvas";

test("standalone core round trips and resizes in its expected hosting context", async ({
  page,
  releaseUrl,
  iframeUrl,
}) => {
  await page.goto(threaded ? releaseUrl + "core-fixture.html" : iframeUrl);
  const core = threaded
    ? page
    : page.frame({ url: releaseUrl + "core-fixture.html" });
  expect(core).toBeTruthy();
  await core.waitForFunction(() => !!globalThis.coreReady);
  expect(new URL(page.url()).origin === new URL(core.url()).origin).toBe(
    threaded,
  );
  expect(await core.evaluate(() => crossOriginIsolated)).toBe(threaded);

  const elements = await core.evaluate(async (fixture) => {
    const editor = await globalThis.coreReady;
    editor.addEventListener("statechange", ({ detail }) => {
      globalThis.lastCoreState = detail;
    });
    editor.loadMolecule(fixture, "xyz");
    return JSON.parse(editor.exportMolecule()).atoms.elements.number;
  }, water);
  expect(elements).toEqual([8, 1, 1]);
  await core.waitForFunction(
    () =>
      globalThis.lastCoreState?.atomCount === 3 &&
      globalThis.lastCoreState?.bondCount === 2,
  );

  const before = await core
    .locator(canvas)
    .first()
    .evaluate((target) => target.clientWidth);
  await core.locator("#viewport").evaluate((viewport) => {
    viewport.style.width = "480px";
  });
  await expect
    .poll(() =>
      core
        .locator(canvas)
        .first()
        .evaluate((target) => target.clientWidth),
    )
    .toBe(before - 160);
});

test("wheel zoom coalesces input and checks live calculation state", async ({
  page,
  releaseUrl,
}) => {
  await page.goto(releaseUrl + "core-fixture.html");
  await page.waitForFunction(() => !!globalThis.coreReady);
  const result = await page.evaluate(async () => {
    const { instance } = await globalThis.coreReady;
    const viewportCanvas = document
      .querySelector("#qt-shadow-container")
      .shadowRoot.querySelector("canvas");
    const deltas = [];
    let reads = 0;
    let calculating = false;
    instance.zoom = (delta) => deltas.push(delta);
    instance.editorState = () => {
      ++reads;
      return JSON.stringify({ calculating });
    };
    const wheel = () =>
      viewportCanvas.dispatchEvent(
        new WheelEvent("wheel", {
          deltaY: 60,
          bubbles: true,
          composed: true,
          cancelable: true,
        }),
      );
    const frame = () => new Promise((done) => requestAnimationFrame(done));
    const notify = () =>
      instance.onEditorStateChanged(JSON.stringify({ calculating }));

    wheel();
    wheel();
    await frame();
    wheel();
    calculating = true;
    await frame();
    notify();
    wheel();
    await frame();
    calculating = false;
    notify();
    wheel();
    await frame();

    return { reads, deltas };
  });
  expect(result).toEqual({ reads: 3, deltas: [-1, -0.5] });
});

test("host scroll works over the canvas when wheel zoom is disabled", async ({
  page,
  releaseUrl,
}) => {
  await page.goto(releaseUrl + "core-fixture.html?scroll");
  await page.waitForFunction(() => !!globalThis.coreReady);
  await page.evaluate(async (fixture) => {
    const editor = await globalThis.coreReady;
    editor.loadMolecule(fixture, "xyz");
    document.body.style.minHeight = "200vh";
    globalThis.zoomCalls = 0;
    globalThis.qtWheelEvents = 0;
    editor.instance.zoom = () => ++globalThis.zoomCalls;
    document
      .querySelector("#qt-shadow-container")
      .shadowRoot.addEventListener("wheel", () => ++globalThis.qtWheelEvents, {
        capture: true,
      });
  }, water);
  const box = await page.locator("#viewport").boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 120);
  await page.waitForFunction(() => scrollY > 0);
  expect(
    await page.evaluate(() => [globalThis.zoomCalls, globalThis.qtWheelEvents]),
  ).toEqual([0, 0]);
});

async function expectStartupFailure(page, message) {
  await expect(page.locator("#status")).toHaveText(
    "The editor could not start.",
  );
  await expect(page.locator("#loading")).toContainText(message);
  await expect(page.locator("#document-controls")).toHaveJSProperty(
    "disabled",
    true,
  );
  await expect(page.locator("#controls")).toHaveJSProperty("disabled", true);
}

test("unsupported WebGL reports a visible startup failure", async ({
  page,
  releaseUrl,
}) => {
  await page.addInitScript(() => {
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...args) {
      return type === "webgl2" ? null : getContext.call(this, type, ...args);
    };
  });
  await page.goto(releaseUrl);
  await expectStartupFailure(page, /WebGL 2 is unavailable/);
});

test("missing runtime reports a visible startup failure", async ({
  page,
  releaseUrl,
}) => {
  await page.route("**/avogadro-web.wasm", (route) =>
    route.fulfill({ status: 404 }),
  );
  await page.goto(releaseUrl);
  await expectStartupFailure(page, /wasm/i);
});

test("threaded editor reports isolation requirement", async ({
  page,
  serveWithoutIsolation,
}) => {
  test.skip(
    !threaded,
    "Only the threaded build requires cross-origin isolation",
  );
  await page.goto(serveWithoutIsolation);
  await expectStartupFailure(page, /cross-origin isolation/i);
});

test("single-threaded editor works from a lone file with no external requests", async ({
  page,
  offlineUrl,
}) => {
  test.skip(
    !offlineUrl,
    "Only the single-threaded build includes offline HTML",
  );
  const requests = [];
  page.on("request", (request) => {
    const requestUrl = request.url();
    if (requestUrl !== offlineUrl && /^(file|https?):/.test(requestUrl)) {
      requests.push(requestUrl);
    }
  });
  await openEditor(page, offlineUrl);
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(false);
  await page.locator("#viewport").click();
  await expect(page.locator("#counts")).toHaveText("5 atoms · 4 bonds");
  await page.locator("#undo").click();
  await expect(page.locator("#counts")).toHaveText("0 atoms · 0 bonds");
  expect(requests).toEqual([]);
});
