// SPDX-License-Identifier: BSD-3-Clause
import AxeBuilder from "@axe-core/playwright";
import {
  expect,
  exportMolecule,
  openEditor,
  openMolecule,
  test,
  threaded,
} from "./packages.mjs";

const hydrogen = "2\nHydrogen\nH 0 0 0\nH 0 0 0.74\n";

test("release starts with the expected kit capabilities and without test hooks", async ({
  page,
  releaseUrl,
}) => {
  await openEditor(page, releaseUrl);
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(threaded);
  expect(
    await page.evaluate(() => [
      typeof globalThis.updateAvogadroViewportForTest,
      typeof globalThis.avogadroAtomPositionForTest,
    ]),
  ).toEqual(["undefined", "undefined"]);

  await page.getByRole("tab", { name: "Calculate" }).click();
  if (threaded) {
    await expect(page.locator("#calculations")).toBeVisible();
    await expect(page.locator("#optimize")).toBeVisible();
  } else {
    await expect(page.locator("#calculations")).toBeHidden();
    await expect(page.locator("#calculation-unavailable")).toBeVisible();
    await expect(page.locator('[data-tool="AutoOpt"]')).toHaveCount(0);
  }
});

test("draw, focus shortcuts, select, delete, undo and export", async ({
  page,
  releaseUrl,
}) => {
  await openEditor(page, releaseUrl);
  const viewport = page.locator("#viewport");
  const counts = page.locator("#counts");
  await viewport.click();
  await expect(counts).toHaveText("5 atoms · 4 bonds");
  expect(
    await page.evaluate(() => {
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    }),
  ).toBe(true);

  await viewport.focus();
  await viewport.press("Control+z");
  await expect(counts).toHaveText("0 atoms · 0 bonds");
  await viewport.press("Control+Shift+z");
  await expect(counts).toHaveText("5 atoms · 4 bonds");

  const newFile = page.getByRole("button", { name: "New", exact: true });
  await newFile.click();
  await page.getByRole("button", { name: "Keep editing" }).click();
  await expect(viewport).toBeFocused();
  await expect(counts).toHaveText("5 atoms · 4 bonds");
  await newFile.click();
  await page.getByRole("button", { name: "Discard changes" }).click();
  await expect(counts).toHaveText("0 atoms · 0 bonds");

  const element = page.locator("#element");
  await element.selectOption("8");
  await page.locator("#bond").selectOption("2");
  await page.locator("#hydrogens").uncheck();
  await viewport.click();
  await expect(counts).toHaveText("1 atoms · 0 bonds");
  await element.focus();
  await page.keyboard.press("Backspace");
  await expect(counts).toHaveText("1 atoms · 0 bonds");

  await page.locator('[data-tool="select"]').click();
  await viewport.click();
  await page.locator("#delete").click();
  await expect(counts).toHaveText("0 atoms · 0 bonds");
  await page.locator("#undo").click();
  await expect(counts).toHaveText("1 atoms · 0 bonds");

  const { text } = await exportMolecule(page, "cjson");
  expect(JSON.parse(text).atoms.elements.number).toEqual([8]);
  await expect(page.locator("#document-name")).toHaveText("Untitled");
});

test("imports first record and preserves document on failed import", async ({
  page,
  releaseUrl,
}) => {
  await openEditor(page, releaseUrl);
  await openMolecule(page, "hydrogen.xyz", hydrogen + "1\nOxygen\nO 1 1 1\n");
  const counts = page.locator("#counts");
  await expect(counts).toHaveText("2 atoms · 0 bonds");
  await expect(page.locator("#status")).toContainText(/first/i);
  await page.locator("#file").setInputFiles({
    name: "invalid.cjson",
    mimeType: "text/plain",
    buffer: Buffer.from("plain text"),
  });
  await expect(page.locator("#status")).toHaveAttribute("data-error", "true");
  await expect(page.locator("#document-name")).toHaveText("hydrogen.xyz");
  await expect(counts).toHaveText("2 atoms · 0 bonds");

  for (const format of ["mol", "sdf", "xyz", "cjson"]) {
    const { name, text } = await exportMolecule(page, format);
    expect(name).toBe("hydrogen." + format);
    expect(text.length).toBeGreaterThan(15);
    if (format === "cjson")
      expect(JSON.parse(text).atoms.elements.number).toEqual([1, 1]);
    if (format === "sdf") expect(text).toContain("$$$$");
    if (format === "xyz") expect(text).toMatch(/^2\n/);
  }
});

test("theme persists, inspector changes layout and keyboard dismisses export", async ({
  page,
  releaseUrl,
}) => {
  await openEditor(page, releaseUrl);
  const root = page.locator("html");
  const viewport = page.locator("#viewport");
  await expect(root).toHaveAttribute("data-theme", "dark");
  await page.locator("#theme").click();
  await expect(root).toHaveAttribute("data-theme", "light");
  await page.reload();
  await expect(page.locator("#controls")).toHaveJSProperty("disabled", false);
  await expect(root).toHaveAttribute("data-theme", "light");

  const width = (await viewport.boundingBox()).width;
  await page.locator("#inspector-toggle").click();
  await expect
    .poll(async () => (await viewport.boundingBox()).width)
    .toBeGreaterThan(width);
  await page.locator("#inspector-toggle").click();

  await page.setViewportSize({ width: 760, height: 700 });
  const toggle = page.locator("#inspector-toggle");
  if ((await toggle.getAttribute("aria-expanded")) === "false")
    await toggle.click();
  const tool = page.getByRole("tab", { name: "Tool" });
  const display = page.getByRole("tab", { name: "Display" });
  await tool.focus();
  await tool.press("ArrowRight");
  await expect(display).toBeFocused();
  await expect(display).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Escape");
  await expect(page.locator("#inspector-toggle")).toBeFocused();

  await page.locator("#export-toggle").click();
  await expect(page.locator("#format")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator("#export-toggle")).toBeFocused();
  await expect(page.locator("#export-menu")).toBeHidden();
});

test("loaded editor has no axe accessibility violations", async ({
  page,
  releaseUrl,
}) => {
  await openEditor(page, releaseUrl);
  // Qt owns the injected keyboard proxy inside its shadow tree.
  const result = await new AxeBuilder({ page })
    .exclude({
      fromShadowDom: ["#qt-shadow-container", ".qt-window-input-element"],
    })
    .analyze();
  expect(
    result.violations.map(({ id, nodes }) => ({
      id,
      targets: nodes.map(({ target }) => target),
    })),
  ).toEqual([]);
});

test("WebMCP reads the unsaved graph and does not download", async ({
  page,
  releaseUrl,
  browserName,
}) => {
  test.skip(
    browserName !== "chromium",
    "WebMCP testing interface currently requires Chromium",
  );
  await openEditor(page, releaseUrl);
  const downloads = [];
  page.on("download", (download) =>
    downloads.push(download.suggestedFilename()),
  );
  await page.locator("#viewport").click();
  await expect(page.locator("#counts")).toHaveText("5 atoms · 4 bonds");
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const context = document.modelContext;
        return (
          !!context &&
          (await context.getTools()).some(
            (tool) => tool.name === "inspect_molecule",
          )
        );
      }),
    )
    .toBe(true);

  const graph = await page.evaluate(async () => {
    const context = document.modelContext;
    const tool = (await context.getTools()).find(
      ({ name }) => name === "inspect_molecule",
    );
    const result = await context.executeTool(tool, {});
    return typeof result === "string" ? JSON.parse(result) : result;
  });
  expect(graph).toMatchObject({ modified: true, atomCount: 5, bondCount: 4 });
  expect(graph.atoms.map(({ atomicNumber }) => atomicNumber)).toEqual([
    6, 1, 1, 1, 1,
  ]);
  expect(
    graph.bonds
      .map(({ begin, end, order }) => [
        Math.min(begin, end),
        Math.max(begin, end),
        order,
      ])
      .sort((a, b) => a[1] - b[1]),
  ).toEqual([
    [0, 1, 1],
    [0, 2, 1],
    [0, 3, 1],
    [0, 4, 1],
  ]);
  expect(downloads).toEqual([]);
  await expect(page.locator("#document-name")).toHaveText(/[*]$/);
});

test("theme preserves a modified molecule and runtime exit disables the editor", async ({
  page,
  releaseUrl,
}) => {
  // Observe the real runtime and its exit callback at the public Qt loader boundary.
  await page.route("**/qtloader.js", async (route) => {
    const response = await route.fetch();
    const source = await response.text();
    await route.fulfill({
      response,
      body:
        source +
        "\nconst loadAvogadroForTests = qtLoad;\n" +
        "qtLoad = async options => {\n" +
        "  globalThis.testRuntimeExit = options.qt.onExit;\n" +
        "  globalThis.runtimeForTests = await loadAvogadroForTests(options);\n" +
        "  return globalThis.runtimeForTests;\n" +
        "};\n",
    });
  });
  await openEditor(page, releaseUrl);
  await page.locator("#viewport").click();
  await expect(page.locator("#counts")).toHaveText("5 atoms · 4 bonds");
  const snapshot = () =>
    page.evaluate(() => ({
      state: JSON.parse(globalThis.runtimeForTests.editorState()),
      molecule: globalThis.runtimeForTests.exportMolecule("cjson"),
    }));
  const before = await snapshot();
  await page.locator("#theme").click();
  expect(await snapshot()).toEqual(before);

  await page.evaluate(() =>
    globalThis.testRuntimeExit({ text: "Simulated runtime exit" }),
  );
  await expect(page.locator("#controls")).toHaveJSProperty("disabled", true);
  await expect(page.locator("#document-controls")).toHaveJSProperty(
    "disabled",
    true,
  );
  await expect(page.locator("#viewport")).toHaveAttribute("inert");
});
