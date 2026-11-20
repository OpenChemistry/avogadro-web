# Building and testing Avogadro web

## Automated browser checks

Tests use fresh profiles and never attach to a user's browser. Chromium's test
uses Node's built-in APIs. Firefox and startup-failure tests use `puppeteer-core`
(optionally located by `PUPPETEER_MODULE`). Firefox can run inside `xvfb-run` for
software rendering on Linux. The startup test serves its own standalone core
fixture alongside the staged build and checks startup errors. In single-threaded
mode it also tests the fixture in a cross-origin iframe without isolation.
CI runs the Chromium startup and smoke tests for both staged release builds.
To install the locked test dependency locally, run
`npm --prefix avogadro-web/tests/browser ci --ignore-scripts`.

```sh
node avogadro-web/tests/browser/browser-smoke.mjs http://127.0.0.1:8000 evidence/chromium
xvfb-run -a node avogadro-web/tests/browser/firefox-smoke.mjs \
  http://127.0.0.1:8000 evidence/firefox
node avogadro-web/tests/browser/startup-failures.mjs stage-wasm_multithread/share/avogadro-web
node avogadro-web/tests/browser/startup-failures.mjs stage-wasm_singlethread/share/avogadro-web --single-threaded
python3 avogadro-web/tests/check-build-profile.py build-wasm_multithread wasm_multithread
python3 avogadro-web/tests/check-build-profile.py build-wasm_singlethread wasm_singlethread
```

To test opening the single-threaded build from disk, copy the offline page
to an otherwise empty directory and run the Chromium smoke test with its
`file://` URL.

```sh
offline_test=$(mktemp -d)
cp stage-wasm_singlethread/share/avogadro-web/avogadro-offline.html "$offline_test/"
node avogadro-web/tests/browser/browser-smoke.mjs \
  "file://$offline_test/avogadro-offline.html" evidence/offline
```

To include the external `QWidget::update()` regression, build WASM with
`-DENABLE_TESTING=ON`, serve that build, and run:

```sh
node avogadro-web/tests/browser/browser-smoke.mjs http://127.0.0.1:8000 evidence/widget-update --widget-update
```

For the tool and display tests, serve a WASM build made with
`-DENABLE_TESTING=ON` and run:

```sh
node avogadro-web/tests/browser/browser-smoke.mjs http://127.0.0.1:8000 evidence/plugins --plugins
```


Pass `--single-threaded` to the hosted single-threaded Chrome smoke test to
verify that the editor hides unavailable calculation controls. The offline test
checks this automatically.

To include calculation checks in the multithreaded Chrome run, set
`AVOGADRO_FCHK_FIXTURE` to the absolute path of
`avogadrodata/data/fchk/h2o-restricted.fchk` in the superbuild checkout.

## Build

Use a **fresh build directory and install prefix** for each profile. Reusing an
installation with more features can leave obsolete plugins and headers behind.
Run these commands from the OpenChemistry superbuild root, with its submodules
already available. Native examples assume CMake, Ninja and the selected Qt kit
are on the appropriate paths.

```sh
# Normal native defaults remain enabled.
cmake -S . -B build-native-new -G Ninja \
  -DCMAKE_PREFIX_PATH=/path/to/Qt/6.11.1/gcc_64
cmake --build build-native-new --parallel 4

# Native desktop without external processes or Python script plugins.
cmake -S . -B build-native-no-process-new -G Ninja \
  -DCMAKE_PREFIX_PATH=/path/to/Qt/6.11.1/gcc_64 \
  -DENABLE_SUBPROCESS=OFF
cmake --build build-native-no-process-new --parallel 4

# Qt 6.11.1 WASM and Emscripten 4.0.7.
# Use the SDK's normal environment activation before configuring.
kit=wasm_multithread  # Set to wasm_singlethread for the embeddable build.
"/path/to/Qt/6.11.1/$kit/bin/qt-cmake" \
  -S . -B "build-$kit" -G Ninja -DCMAKE_BUILD_TYPE=Release \
  -DQT_HOST_PATH=/path/to/Qt/6.11.1/gcc_64
cmake --build "build-$kit" --parallel 4
# Stage the application into a separate, empty destination.
cmake --install "build-$kit/avogadro-web" --prefix "$PWD/stage-$kit"
```

Run the commands from the superbuild root once per kit. The Qt kit sets the
threading mode for both the libraries and the web editor. Use a superbuild
revision that supports both Qt kits, such as the revision pinned in CI.
The single-threaded build uses Python 3 to generate `avogadro-offline.html`,
which is included in the staged package.

From `stage-wasm_multithread/share/avogadro-web`, run `python3 serve-wasm.py`
to serve with the required isolation headers and optional gzip compression.
From `stage-wasm_singlethread/share/avogadro-web`, run
`python3 -m http.server --bind 127.0.0.1` to serve without isolation headers.
Open `http://127.0.0.1:8000/` and stop the server with Ctrl+C.

`ENABLE_SUBPROCESS` defaults ON natively and OFF under Emscripten; it is separate
from `USE_PYTHON`, which builds Python API bindings. Its value is exported as
`AvogadroLibs_USE_SUBPROCESS` and through the native target definition
`AVOGADRO_USE_SUBPROCESS`. Disabled script/package APIs are not installed.

`AVOGADRO_WEB_EDITOR` defaults OFF natively and ON under Emscripten. This profile
requires subprocess, libarchive, plotting and desktop RPC to be OFF and static
plugins to be ON. WASM requires static libraries and no Python bindings.
Incompatible explicit requests fail configuration rather than being silently
forced off. Native code tests use `ENABLE_TESTING=ON`; browser tests execute the
WASM release. The superbuild maps `ENABLE_SUBPROCESS` to the library option `USE_SUBPROCESS`.

For a native version of the same web controller and its tests, build
avogadrolibs with `USE_SUBPROCESS=OFF`, `USE_LIBARCHIVE=OFF`,
`USE_PLOTTER=OFF` and `BUILD_STATIC_PLUGINS=ON`, then build this repository
against that installation. The native executable is useful for debugging; the HTML
interface is delivered only by the WASM package. Set `ENABLE_TESTING=ON` on both
projects and provide GoogleTest. Run `ctest --test-dir <web-build>` and the
Core/Io/QtGui/Rendering suites in the libraries build.

## Standalone build

This repository owns the web executable, controller, browser assets and tests.
The desktop application remains in `avogadroapp`; the rendering and molecular
libraries remain in `avogadrolibs`. The superbuild selects `avogadro-web` when
`AVOGADRO_WEB_EDITOR=ON` and `avogadroapp` otherwise.

To build this repository directly against an installed web-profile library:

```sh
cmake -S avogadro-web -B build-web-controller -G Ninja \
  -DCMAKE_PREFIX_PATH="/path/to/web-profile/prefix;/path/to/Qt/6.11.1/gcc_64" \
  -DENABLE_TESTING=ON
cmake --build build-web-controller --parallel 4
ctest --test-dir build-web-controller --output-on-failure
```

For WASM, configure this repository with `qt-cmake` from the WASM Qt kit and
point `CMAKE_PREFIX_PATH` and `CMAKE_FIND_ROOT_PATH` at the matching WASM
Avogadro library installation. Use a fresh build directory. No source files or CMake modules from `avogadroapp` are needed.

Workspace UI checks (use a runtime with the current plugins):

```sh
node avogadro-web/tests/browser/ui-smoke.mjs http://127.0.0.1:8000 evidence/ui --full-runtime
```

## Optional toolkit layout

Place browser adapters and workers under `web/toolkits/<toolkit>/`.
Use `thirdparty/<toolkit>/` for any toolkit build recipe or native bridge
maintained here. A toolkit can ship its own JavaScript and WASM as optional,
self-hosted assets. The host can explicitly enable staged tools and start a
toolkit worker when the user first invokes one of its operations.

The [Open Babel worker proposal](https://github.com/OpenChemistry/avogadro-web/pull/19)
on `codex/openbabel-web` shows how to load WASM on demand and reject stale
results before applying them to the document. [RDKit.js MinimalLib](https://github.com/rdkit/rdkit/blob/master/Code/MinimalLib/README.md)
is a candidate for a second adapter with its own WASM module. Keep the worker
interfaces toolkit-specific until two implementations show what they share.

See the [integration examples plan](examples/README.md) for host applications.

Run `python3 tests/check-page-security.py` to check the shipped page and its
JavaScript for forbidden DOM sinks and inline handlers. The Chromium smoke test
records CSP violations from the first navigation through document editing. Run
it against both served kits and the standalone single-threaded HTML file.
