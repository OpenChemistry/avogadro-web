// SPDX-License-Identifier: BSD-3-Clause
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  expect,
  exportMolecule,
  openEditor,
  openMolecule,
  test,
  threaded,
} from "./packages.mjs";

const toolFixture = {
  chemicalJson: 1,
  atoms: { elements: { number: [6, 8] }, coords: { "3d": [1, 1, 0, 3, 2, 0] } },
  bonds: { connections: { index: [0, 1] }, order: [1] },
};

test("test hook triggers a redraw after the viewport becomes idle", async ({
  page,
  hookUrl,
}) => {
  test.skip(!hookUrl, "Provide the separately staged test-hook build");
  await page.addInitScript(() => {
    globalThis.drawCalls = 0;
    for (const name of [
      "drawArrays",
      "drawElements",
      "drawArraysInstanced",
      "drawElementsInstanced",
    ]) {
      const original = WebGL2RenderingContext.prototype[name];
      WebGL2RenderingContext.prototype[name] = function (...args) {
        original.apply(this, args);
        if (this.canvas.getRootNode().host?.id === "qt-shadow-container")
          ++globalThis.drawCalls;
      };
    }
  });
  await openEditor(page, hookUrl);
  await page.locator("#viewport").click();
  await expect(page.locator("#counts")).toHaveText("5 atoms · 4 bonds");
  await page.waitForFunction(() => globalThis.drawCalls > 0);
  const before = await page.evaluate(async () => {
    const frames = () =>
      new Promise((resolve) => requestAnimationFrame(resolve));
    let quiet = 0;
    let last = globalThis.drawCalls;
    for (let i = 0; i < 300 && quiet < 10; ++i) {
      await frames();
      const next = globalThis.drawCalls;
      quiet = next === last ? quiet + 1 : 0;
      last = next;
    }
    if (quiet < 10) throw new Error("Viewport never settled");
    globalThis.updateAvogadroViewportForTest();
    return last;
  });
  await page.waitForFunction(
    (previous) => globalThis.drawCalls > previous,
    before,
  );
});

test("display factories persist selected styles through CJSON", async ({
  page,
  releaseUrl,
}) => {
  await openEditor(page, releaseUrl);
  await openMolecule(page, "styled.cjson", JSON.stringify(toolFixture));
  const tools = page.locator("[data-tool]");
  const styles = page.locator("[data-style]");
  expect(
    await tools.evaluateAll((buttons) =>
      buttons.map((button) => button.dataset.tool),
    ),
  ).toEqual(
    expect.arrayContaining([
      "navigate",
      "draw",
      "select",
      "MeasureTool",
      "Manipulator",
      "AlignTool",
      "BondCentric",
      "LabelEditor",
    ]),
  );
  expect(
    await styles.evaluateAll((inputs) =>
      inputs.map((input) => input.dataset.style),
    ),
  ).toEqual(
    expect.arrayContaining([
      "BallStick",
      "Licorice",
      "VanDerWaals",
      "Wireframe",
      "Label",
      "Cartoons",
      "CrystalScene",
    ]),
  );

  await page.getByRole("tab", { name: "Display" }).click();
  const ballAndStick = page.locator('[data-style="BallStick"]');
  const licorice = page.locator('[data-style="Licorice"]');
  await ballAndStick.uncheck();
  await licorice.check();
  const saved = await exportMolecule(page, "cjson");
  expect(JSON.parse(saved.text).layer.enable).toMatchObject({
    Licorice: [true],
    "Ball and Stick": [false],
  });
  await openMolecule(page, "round-trip.cjson", saved.text);
  await expect(licorice).toBeChecked();
  await expect(ballAndStick).not.toBeChecked();
});

test("plugin tools align, manipulate, stretch and label picked atoms", async ({
  page,
  hookUrl,
}) => {
  test.skip(
    !hookUrl,
    "Atom position test hook is required for reliable picking",
  );
  await openEditor(page, hookUrl);
  await openMolecule(page, "tools.cjson", JSON.stringify(toolFixture));

  const tool = async (id) => {
    const button = page.locator('[data-tool="' + id + '"]');
    await button.click();
    await expect(button).toHaveAttribute("aria-pressed", "true");
  };
  const atom = (index) =>
    page.evaluate((i) => {
      const viewport = document
        .querySelector("#viewport")
        .getBoundingClientRect();
      const position = globalThis.avogadroAtomPositionForTest(i);
      return { x: viewport.x + position.x, y: viewport.y + position.y };
    }, index);
  const pick = async (index) => {
    const { x, y } = await atom(index);
    await page.mouse.click(x, y);
  };
  const drag = async ({ x, y }, dx, dy, button = "left") => {
    await page.mouse.move(x, y);
    await page.mouse.down({ button });
    await page.mouse.move(x + dx, y + dy, { steps: 3 });
    await page.mouse.up({ button });
  };
  const cjson = async () =>
    JSON.parse((await exportMolecule(page, "cjson")).text);
  const undo = async () => {
    await page.locator("#undo").click();
    await expect(page.locator("#redo")).toBeEnabled();
  };

  await tool("AlignTool");
  await pick(0);
  await pick(1);
  await page.locator("#align-axis").selectOption("y");
  await page.locator("#align").click();
  await expect(page.locator("#undo")).toBeEnabled();
  const aligned = (await cjson()).atoms.coords["3d"];
  for (const [index, value] of [0, 0, 0, 0, Math.sqrt(5), 0].entries()) {
    expect(aligned[index]).toBeCloseTo(value, 5);
  }
  await undo();
  expect((await cjson()).atoms.coords["3d"]).toEqual([1, 1, 0, 3, 2, 0]);

  await tool("Manipulator");
  await drag(await atom(0), 20, -15);
  const moved = (await cjson()).atoms.coords["3d"];
  expect(moved.slice(0, 3)).not.toEqual([1, 1, 0]);
  expect(moved.slice(3)).toEqual([3, 2, 0]);
  await undo();

  await tool("BondCentric");
  const left = await atom(0);
  const right = await atom(1);
  await page.mouse.click((left.x + right.x) / 2, (left.y + right.y) / 2);
  await drag(right, 30, -15, "right");
  const [x0, y0, z0, x1, y1, z1] = (await cjson()).atoms.coords["3d"];
  expect(Math.hypot(x1 - x0, y1 - y0, z1 - z0)).not.toBeCloseTo(
    Math.sqrt(5),
    3,
  );
  await undo();

  await tool("LabelEditor");
  await pick(0);
  await expect(page.locator("#label-options")).toBeVisible();
  await page.locator("#atom-label").fill("T");
  await page.locator("#label-options button").click();
  expect((await cjson()).atoms.labels[0]).toBe("T");
  await expect(page.locator('[data-style="Label"]')).toBeChecked();
});

test("threaded optimization changes coordinates and surfaces become available", async ({
  page,
  releaseUrl,
}) => {
  test.skip(!threaded, "Worker-based calculations require the threaded build");
  await openEditor(page, releaseUrl);
  await openMolecule(
    page,
    "strained.xyz",
    "3\nStrained water\nO 0 0 0\nH 0.55 0 0\nH 0 0.65 0\n",
  );
  const coordinates = async () =>
    JSON.parse((await exportMolecule(page, "cjson")).text).atoms.coords["3d"];
  const before = await coordinates();
  await page.getByRole("tab", { name: "Calculate" }).click();
  await page.getByRole("button", { name: "Optimize Geometry" }).click();
  await expect(page.locator("#calculation-status")).toContainText("UFF Energy");
  expect(await coordinates()).not.toEqual(before);
  await page.locator("#undo").click();
  expect(await coordinates()).toEqual(before);

  const render = page.getByRole("button", { name: "Render surface" });
  for (const type of [
    "renderVDW",
    "renderSolventExcluded",
    "renderSolventAccessible",
  ]) {
    await page.locator("#surface-type").selectOption(type);
    await render.click();
    await expect(page.locator("#calculation-status")).toHaveText(
      "Surface Finished",
      { timeout: 30_000 },
    );
    await expect(render).toBeEnabled();
    await expect(page.locator('[data-style="SurfaceRender"]')).toBeChecked();
  }
});

test("threaded FCHK, Molden and cube files render quantum surfaces", async ({
  page,
  releaseUrl,
}) => {
  const fixture = process.env.AVOGADRO_FCHK_FIXTURE;
  test.skip(
    !threaded || !fixture,
    "Provide the pinned formatted-checkpoint fixture to the threaded build",
  );
  await openEditor(page, releaseUrl);
  await openMolecule(page, "water.fchk", await readFile(fixture, "utf8"));
  await page.getByRole("tab", { name: "Calculate" }).click();
  const render = async (type) => {
    await page.locator("#surface-type").selectOption(type);
    await expect(page.locator("#orbital-label")).toBeVisible({
      visible: type === "renderOrbital",
    });
    await page.getByRole("button", { name: "Render surface" }).click();
    await expect(page.locator("#calculation-status")).toHaveText(
      "Surface Finished",
      { timeout: 30_000 },
    );
    await expect(page.locator('[data-style="SurfaceRender"]')).toBeChecked();
  };
  await render("renderOrbital");
  await render("renderElectronDensity");

  const data = resolve(fixture, "../..");
  await openMolecule(
    page,
    "water.molden",
    await readFile(resolve(data, "molden/H2O.molden"), "utf8"),
  );
  await render("renderOrbital");
  await openMolecule(
    page,
    "benzene.cube",
    await readFile(resolve(data, "cube/benzene-homo.cube"), "utf8"),
  );
  await render("renderCube");
});

test("camera rotation, panning, wheel zoom and fit change viewport projection", async ({
  page,
  hookUrl,
}) => {
  test.skip(
    !hookUrl,
    "Atom position test hook is required to read camera projection",
  );
  await openEditor(page, hookUrl);
  await openMolecule(page, "camera.cjson", JSON.stringify(toolFixture));
  await page.locator('[data-tool="navigate"]').click();
  const projected = () =>
    page.evaluate(() =>
      [0, 1].map((index) => {
        const { x, y } = globalThis.avogadroAtomPositionForTest(index);
        return [Math.round(x), Math.round(y)];
      }),
    );
  const viewport = page.locator("#viewport");
  const box = await viewport.boundingBox();
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  const drag = async (button) => {
    await page.mouse.move(x, y);
    await page.mouse.down({ button });
    await page.mouse.move(x + 70, y + 25, { steps: 4 });
    await page.mouse.up({ button });
  };

  const initial = await projected();
  await drag("left");
  await expect.poll(projected).not.toEqual(initial);
  const rotated = await projected();
  await drag("middle");
  await expect.poll(projected).not.toEqual(rotated);
  const panned = await projected();
  await page.mouse.wheel(0, 180);
  await expect.poll(projected).not.toEqual(panned);
  const zoomed = await projected();
  await page.locator("#reset").click();
  await expect.poll(projected).not.toEqual(zoomed);
  await page.setViewportSize({ width: 900, height: 700 });
  await expect
    .poll(async () => (await viewport.boundingBox()).width)
    .not.toEqual(box.width);
  await expect(page.locator("#counts")).toHaveText("2 atoms · 1 bonds");
});
