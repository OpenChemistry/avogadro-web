import globals from "globals";

export default [
  { ignores: ["**/dependencies/", "**/build-*/", "**/native-prefix/"] },
  {
    files: ["**/*.js", "**/*.mjs"],
    rules: {
      "no-duplicate-case": "error",
      "no-unreachable": "error",
      "no-undef": "error",
      "no-unused-vars": ["error", { args: "none", caughtErrors: "none" }],
    },
  },
  {
    files: ["web/**/*.js", "tests/browser/fixtures/**/*.js"],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ["tests/browser/**/*.mjs", "tools/**/*.mjs"],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  {
    files: ["tests/browser/startup-failures.mjs"],
    languageOptions: {
      globals: { zoomCalls: "readonly", qtWheelEvents: "readonly" },
    },
  },
  {
    files: ["tests/browser/ui-smoke.mjs"],
    languageOptions: {
      globals: { testRuntime: "readonly", testExit: "readonly" },
    },
  },
];
