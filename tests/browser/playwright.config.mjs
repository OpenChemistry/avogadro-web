// SPDX-License-Identifier: BSD-3-Clause
import { defineConfig } from "@playwright/test";

const swiftshader = [
  "--enable-unsafe-swiftshader",
  "--use-angle=swiftshader",
  "--enable-features=WebMCP,WebMCPTesting",
];

export default defineConfig({
  testDir: "./playwright",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  workers: 1,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: {
    viewport: { width: 1200, height: 800 },
    actionTimeout: 12000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    headless: !process.env.PLAYWRIGHT_HEADED,
  },
  projects: [
    {
      name: "chromium",
      use: {
        browserName: "chromium",
        launchOptions: {
          args: swiftshader,
          executablePath: process.env.CHROME_BINARY,
        },
      },
    },
    {
      name: "firefox",
      use: {
        browserName: "firefox",
        launchOptions: {
          firefoxUserPrefs: {
            "webgl.disabled": false,
            "webgl.force-enabled": true,
          },
        },
      },
    },
    { name: "webkit", use: { browserName: "webkit" } },
  ],
});
