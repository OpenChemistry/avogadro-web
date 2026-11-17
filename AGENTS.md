# Avogadro Web: Guide for Contributors and Coding Agents

avogadro-web is a browser front end for
[Avogadro](https://two.avogadro.cc). The molecule, tools, undo/redo,
rendering and file formats are the C++ code in
[avogadrolibs](https://github.com/OpenChemistry/avogadrolibs), compiled to
WebAssembly with Qt. This repository adds an HTML page, JavaScript, CSS,
and a thin C++ controller that connects the page to the Avogadro plugins.

This file explains what belongs here and **why**. Read the avogadrolibs
[AGENTS.md](https://github.com/OpenChemistry/avogadrolibs/blob/master/AGENTS.md)
as well; its C++ rules apply to the C++ in this repository.

## AI use policy

Proposed:

- **C++ in this repository** (everything under `src/*.cpp`, `src/*.h` and
  `tests/native/webcontroller.cpp`) follows the avogadrolibs policy: AI assistance
  is minimal and a human reviews, fully understands and owns every line.
- **Interface code** (HTML, CSS, JavaScript, browser tests) may use more AI
  assistance. A human still reviews and approves every pull request, and the
  change must come with tests.
- **Say so.** A pull request states whether AI tools wrote any of it.
- **Scientific code does not belong here** under any policy. See the next
  section.

Agents are welcome to explain code, suggest approaches, help debug and help
review.

## Where does this code go?

Ask these questions in order:

1. **Is it chemistry, geometry, numerics or file-format parsing?**
   avogadrolibs, not here. This includes "small" things such as splitting a
   multi-record file or validating an element.
2. **Is it behavior of a tool, display type or calculation?** The plugin in
   avogadrolibs. Expose it to the page through the plugin's command
   interface (see "Exposing a plugin to the page").
3. **Does it connect the page to plugins, the document or the undo stack?**
   `src/webcontroller.cpp`.
4. **Is it a JavaScript-callable function?** A binding in `src/main.cpp`
   that calls `WebController`. Bindings contain no logic.
5. **Is it layout, styling, or wiring controls to the editor?**
   `web/editor/`.

If you find yourself writing chemistry in JavaScript, stop: it goes in
avogadrolibs, where it is tested and fuzzed. This also keeps the web editor
in sync with the desktop app.

## Files

| Path | Purpose |
|------|---------|
| `src/webcontroller.h`, `src/webcontroller.cpp` | `WebController`: owns the document and layer state; coordinates plugins, undo history, file import and export, theme, and state notifications |
| `src/main.cpp` | Application entry point and the Embind bindings |
| `web/core/avogadro-editor.js` | Reusable runtime wrapper and viewport initialization |
| `web/editor/` | Full editor page, workspace controls, styling, logo, and WebMCP registration |
| `tests/native/webcontroller.cpp` | GoogleTest cases for `WebController`, native build only |
| `tests/browser/browser-smoke.mjs` | Chromium test of the real WASM build (Node built-ins only); `--plugins`, `--widget-update` and `--webmcp` add optional checks |
| `tests/browser/firefox-smoke.mjs` | Firefox test of the same build (`puppeteer-core`) |
| `tests/browser/ui-smoke.mjs` | Workspace UI checks: theme, inspector, tooltips, keyboard (`puppeteer-core`) |
| `tests/browser/startup-failures.mjs` | Standalone core smoke fixture and startup error paths (runs its own server) |
| `tests/check-build-profile.py` | Checks the exact set of plugins and excluded sources in a WASM build tree |
| `tools/serve-wasm.py` | Local test server that sends the required headers. Loopback only. Shipped at the package root |
| `docs/images/workspace.png` | README screenshot, also installed in the package |
| `.github/workflows/build_wasm.yml` | CI build, package checks and the `continuous` prerelease download |
| `README.md` | For users and integrators: running the package, the `AvogadroEditor` API, hosting |
| `BUILDING.md` | For contributors: build profiles, native and WASM builds, test commands |

`CMakeLists.txt` copies the assets into the build's `bin/` directory and
installs them to `share/avogadro-web`. The full editor and server are staged
at the root, and the reusable module is staged under `core/`. Add required
assets to CMake and to the CI "Stage and verify web package" step.

## How the pieces talk

- The page calls bound functions on the Emscripten module. **Only plain
  values cross the boundary**: numbers, booleans, and strings holding JSON.
  No C++ pointers or handles are exposed to JavaScript.
- `WebController::state()` returns one JSON object describing everything the
  page shows. The page **renders from state**; it does not keep its own copy
  of the molecule, the active tool or the options.
- C++ emits `stateChanged`, which reaches the page as a `statechange` event
  on a queued connection, so the page never re-enters a half-updated
  molecule.
- Functions that can fail return `{ ok, error }` (or `false`) and the
  `AvogadroEditor` wrapper turns that into an exception for the page to show.
- The page shows only what the runtime advertises in `state` (`tools`,
  `displayStyles`, `canOptimize`, `canRenderSurfaces`, ...). Do not hard-code
  a control for a capability the runtime has not reported.

### The `AvogadroEditor` wrapper is a public API

README.md documents the wrapper for people building their own page on the
WASM package. Treat its method names, arguments and `statechange` payload as
an interface: change them deliberately, update README.md in the same pull
request, and keep the wrapper independent of the full editor's elements so
hosts can import it directly.

The wrapper also tolerates older runtimes. `normalizeState()` fills in
defaults for state keys that older packages did not report, and optional
bindings such as `setTheme` are feature-tested before use. A new binding
that the page depends on should be handled the same way.

### Exposing a plugin to the page

Plugin options are Qt widgets on the desktop, and the web build has none.
The Draw tool is the model to follow:

1. The plugin accepts a command (`handleCommand("setDrawOptions", map)`) and
   publishes its current options as a property with a change signal.
2. `WebController` forwards the command and includes the property in
   `state()`.
3. `src/main.cpp` adds a one-line binding.
4. The core module adds a wrapper method. The editor calls it and renders
   the control from state.
5. `tests/native/webcontroller.cpp` checks the round trip, including rejected
   values; a browser test checks the control.

Step 1 requires changes in avogadrolibs and pull requests are in progress.
Labels and tooltips come from the plugin; do not write a second copy in
JavaScript.

### WebMCP

In browsers with WebMCP, `editor.js` registers a single tool,
`inspect_molecule`. It is **read-only**: it reads `state` and a CJSON export
and must not change the molecule, the undo stack or the unsaved marker.
Anything returned to an agent is built from runtime data, never from page
text. Adding a tool that edits the document, or that reaches outside the
tab, needs discussion first. Test with `browser-smoke.mjs --webmcp`.

## Rules for C++

The avogadrolibs rules apply. The ones that matter most here:

- **Never crash.** A crash in the browser loses the user's molecule. Validate
  everything that arrives from JavaScript: names, JSON shape, numeric ranges.
  Return a failure; do not throw across the binding.
- **Imports are all-or-nothing.** Parse into a temporary molecule and swap it
  in only on success, so a failed read leaves the document and undo history
  untouched.
- **Every edit is undoable** and goes through `RWMolecule`. Theme and
  camera changes are not edits and never enter undo history.
- **User-visible strings go through `tr()`.**
- **Keep the plugin list in step.** A plugin added to or removed from the
  web build must also change the expected set in
  `tests/check-build-profile.py`. The avogadrolibs change must be merged
  (or, while CI builds from forks, published) first, and the pinned
  `AVOGADROLIBS_REVISION` in `.github/workflows/build_wasm.yml` updated to
  match.
- **Remember the target is 32-bit.** `size_t` is 32 bits in WebAssembly and
  memory is limited. Check sizes computed from file contents.
- Test-only bindings are compiled only under `AVOGADRO_WASM_BROWSER_TESTS`
  (set by `ENABLE_TESTING=ON` in a WASM build) and must never be present in
  a release build.
- Format with `clang-format` (Mozilla base, see `.clang-format`).

## Rules for the page

- **No HTML from strings.** Use `textContent`, `createElement` and
  `replaceChildren`. Do not use `innerHTML`, `outerHTML`,
  `insertAdjacentHTML`, `document.write` or `eval`. File names, error
  messages and molecule data are untrusted text.
- **No third-party scripts, styles or fonts at run time**, and no CDN links.
  The shipped page has no dependencies. Development tools are fine.
- **No inline `<script>` or `style=""` attributes.** They conflict with the
  Content-Security-Policy the project intends to ship.
- **No new network requests** without discussion. "Files stay in your
  browser" is a promise made on the page.
- **Treat input from outside as untrusted**: opened files, URL parameters,
  anything from a host page. Accept only values the build reports as valid.
- **Colors go through CSS custom properties**, defined for both the dark and
  light themes. Do not write color literals in rules or in JavaScript.
- **Browser storage is for preferences only** (today, the theme). Wrap every
  access in `try`; the page must work when storage is unavailable. Never
  store molecule data.
- **Keep it accessible.** Real `<button>`, `<label>` and `<select>` elements;
  `aria-pressed` on toggles; status messages in live regions; every action
  reachable from the keyboard, including the inspector tabs.
- **Do not grab keys globally.** Editor shortcuts apply only while the
  viewport has focus.
- **Check both layouts.** Below 1000px the inspector becomes a drawer.
- Plain JavaScript modules. No framework and no build step for the page.

## Build and test

Build instructions and test commands are in [BUILDING.md](BUILDING.md);
[README.md](README.md) is for people using or embedding the package. In
short:

- The **WebAssembly build** uses the Qt multithreaded WASM kit and the
  matching Emscripten version (currently Qt 6.11.1 and Emscripten 4.0.7,
  pinned in the CI workflow). Qt supports exactly one Emscripten version per
  release; do not change one without the other.
- Use a **fresh build directory and install prefix** for each profile.
- A **native build** of the controller against a web-profile avogadrolibs is
  the quickest way to work on C++:

  ```sh
  cmake -S . -B build -G Ninja -DENABLE_TESTING=ON \
    -DCMAKE_PREFIX_PATH="/path/to/web-profile/prefix;/path/to/Qt"
  cmake --build build
  ctest --test-dir build --output-on-failure
  ```

- **Browser tests** need a staged WebAssembly build served by
  `serve-wasm.py` (`cmake --install <build>/avogadro-web --prefix <stage>`).
  Tests use fresh browser profiles and never attach to a user's browser.
- **CI** (`build_wasm.yml`) builds the WASM package from pinned superbuild
  and avogadrolibs revisions, runs `check-build-profile.py`, verifies the
  staged package and uploads it. Pushes to `main` update the `continuous`
  prerelease. CI does not yet run the browser tests; run them yourself.

What to run before opening a pull request:

| You changed | Run |
|-------------|-----|
| `src/webcontroller.*`, `src/main.cpp` | Native `ctest`, and the browser tests if a binding changed |
| `web/editor/` | `browser-smoke.mjs`, `firefox-smoke.mjs` and `ui-smoke.mjs` |
| Core integration, startup, loading or error handling | `startup-failures.mjs` |
| The WebMCP tool | `browser-smoke.mjs --webmcp` |
| The plugin set | `tests/check-build-profile.py` on a fresh build tree |
| Anything | `pre-commit run --all-files` |

If you could not run something, say so in the pull request. Do not report a
test as passing unless you ran it.

Add a test with every change in behavior: a GoogleTest case for controller
logic, a browser test for anything the user sees. In browser tests, wait for
a state change, not a fixed delay, and find elements by role, label or id,
not by class name.

### Formatting and pre-commit

`.pre-commit-config.yaml` runs whitespace and file checks, `clang-format`
(C++), `gersemi` (CMake), `ruff` (Python), `codespell`, and compression for
PNG (`oxipng`) and SVG (`svgo`). Install with `pre-commit install`.

Prettier is configured for JavaScript, CSS, HTML and Markdown but only in
the manual stage, because the compact style of `editor.js` has not been
agreed on. Do not reformat existing files with it in an unrelated pull
request. Project words that codespell flags (such as element symbols) go in
`.codespellrc`.

## Things that look wrong but are intentional

- **Only CJSON clears the "unsaved" marker.** Other formats can drop
  properties.
- **Only the first record** of a multi-record SDF or XYZ file is imported,
  with a notice.
- **Wheel zoom is clamped** in the controller. Browser wheel events can
  carry hundreds of pixels each.
- **The page refuses to start without cross-origin isolation.** The current
  build is multithreaded and needs `SharedArrayBuffer`.
- **`serve-wasm.py` binds to loopback only.** It is a test server, even
  though it ships in the package.
- **Display styles are re-enabled on load.** If a file has no enabled style
  that the web build has, Ball and Stick is turned on; Crystal Lattice and
  Cartoons are turned on for unit cells and residues.
- **Older runtimes keep a fixed dark canvas.** Packages without the
  `setTheme` binding switch only the page theme; `.runtime-fixed-canvas`
  keeps the canvas overlays legible in both themes.

  pending upstream; the pins move to OpenChemistry once they merge.

## Pull requests

- One topic per pull request. A change that needs avogadrolibs gets a
  separate pull request there, linked from this one.
- Commit messages start with a short imperative sentence, as in
  avogadrolibs.
- Do not edit generated or vendored files (`qtloader.js`, `avogadro-web.js`,
  the `.wasm` and `build-manifest.json` come from the build and are not in
  the repository).
- Update README.md when the wrapper API, the package contents or the hosting
  requirements change, and BUILDING.md when a build option or test command
  changes. Retake `docs/images/workspace.png` when the workspace layout
  changes visibly.
- Do not weaken a test, a check or a security rule to make a change pass.
  Raise it in the pull request instead.
