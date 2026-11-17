# Building and testing Avogadro web

## Automated browser checks

Tests use fresh profiles and never attach to a user's browser. Chromium's test
uses Node's built-in APIs. Firefox and startup-failure tests use `puppeteer-core`
(optionally located by `PUPPETEER_MODULE`). Firefox can run inside `xvfb-run` for
software rendering on Linux. The commands below run the checks against the supplied build.

```sh
node avogadro-web/tests/browser-smoke.mjs http://127.0.0.1:8000 evidence/chromium
xvfb-run -a node avogadro-web/tests/firefox-smoke.mjs \
  http://127.0.0.1:8000 evidence/firefox
node avogadro-web/tests/startup-failures.mjs stage-web-new/share/avogadro-web
python3 avogadro-web/tests/check-build-profile.py build-web-new
```

To include the external `QWidget::update()` regression, build WASM with
`-DENABLE_TESTING=ON`, serve that build, and run:

```sh
node avogadro-web/tests/browser-smoke.mjs http://127.0.0.1:8000 evidence/widget-update --widget-update
```

For the tool and display tests, serve a WASM build made with
`-DENABLE_TESTING=ON` and run:

```sh
node avogadro-web/tests/browser-smoke.mjs http://127.0.0.1:8000 evidence/plugins --plugins
```


To include calculation checks in the Chrome run, set
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

# Qt 6.11.1 multithreaded WASM and Emscripten 4.0.7.
# Use the SDK's normal environment activation before configuring.
/path/to/Qt/6.11.1/wasm_multithread/bin/qt-cmake \
  -S . -B build-web-new -G Ninja -DCMAKE_BUILD_TYPE=Release \
  -DQT_HOST_PATH=/path/to/Qt/6.11.1/gcc_64
cmake --build build-web-new --parallel 4
# Stage the application into a separate, empty destination.
cmake --install build-web-new/avogadro-web --prefix "$PWD/stage-web-new"
cd stage-web-new/share/avogadro-web
python3 serve-wasm.py
```

Open `http://127.0.0.1:8000/`. Stop the server with Ctrl+C. The server binds only to
loopback and serves its working directory. It sends the required isolation
headers and serves the optional precompressed WASM file when gzip is accepted.

Qt's WASM kit selects whether the build uses threads. For the browser release,
use the multithreaded kit and serve it with `Cross-Origin-Opener-Policy:
same-origin` and `Cross-Origin-Embedder-Policy: require-corp`. These headers
enable cross-origin isolation and the `SharedArrayBuffer` used by Qt threads.
The current browser loader requires that isolation. The single-threaded kit
can be used to build the libraries without forcing `-pthread`.

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
node avogadro-web/tests/ui-smoke.mjs http://127.0.0.1:8000 evidence/ui --full-runtime
```

## Optional Open Babel worker

Build the independent module with Emscripten and a local Open Babel 3 checkout.
The module has its own memory and uses Open Babel's compiled-in atom-typing
data. Builder fragments and UFF parameters are embedded in the WASM binary.
Emscripten's virtual filesystem must remain enabled for initialization.
The module runs on one worker thread and does not require Qt.

```sh
emcmake cmake -S avogadro-web/openbabel-wasm -B build-openbabel-wasm -G Ninja \
  -DOPENBABEL_SOURCE_DIR=/path/to/openbabel -DCMAKE_BUILD_TYPE=Release
cmake --build build-openbabel-wasm --target openbabel-web --parallel 4

# Add the module to an already configured Avogadro WASM editor build.
cmake -S avogadro-web -B /path/to/web-build \
  -DOPENBABEL_WASM_DIR="$PWD/build-openbabel-wasm/bin"
cmake --build /path/to/web-build --parallel 4
```

Keep `openbabel-config.js`, `openbabel-client.js`, `openbabel-worker.js`,
`openbabel-web.js` and `openbabel-web.wasm` with the editor assets.
Configure `OPENBABEL_WASM_DIR` to enable the Open Babel tools. The module and
its bridge use GPL-2.0-or-later.

Build the same bridge natively to compare full-precision per-atom results.
Use the same Open Babel checkout for both builds and `ENABLE_TESTING=ON` for
the web editor. The comparison also needs a native `obabel` on `PATH` to generate
fixtures, or an explicit `OBABEL_BINARY` path.

```sh
cmake -S avogadro-web/openbabel-wasm -B build-openbabel-native -G Ninja \
  -DOPENBABEL_SOURCE_DIR=/path/to/openbabel -DCMAKE_BUILD_TYPE=Release
cmake --build build-openbabel-native --target openbabel-web --parallel 4

# Generate a MOL molecule in the native reference's JSON response.
echo 'CCO' | build-openbabel-native/bin/openbabel-web --smiles

# Serve the web-build/bin directory using its serve-wasm.py first.
OPENBABEL_NATIVE_REFERENCE="$PWD/build-openbabel-native/bin/openbabel-web" \
  node avogadro-web/tests/browser-smoke.mjs http://127.0.0.1:8000 \
  build-openbabel-wasm/evidence/browser --openbabel
```

The browser test generates nine molecules from SMILES in both native and WASM
builds. It checks connectivity and stereochemistry against native canonical
SMILES, explicit hydrogens, finite coordinates, bond lengths and nonplanarity
where appropriate, plus invalid input, replacement confirmation and stale
results. `smiles-generation.json` and `generated-*.mol` record the results.

The test also compares Gasteiger charges for water, ethanol, benzene, ammonium, acetate and hydrogen
at a per-atom tolerance of `1e-12`, then checks persistence, undo/redo, stale
results and recovery after invalid input. `openbabel-comparison.json` records
both charge vectors and maximum differences. This preserves the native model's
behavior. In the tested Open Babel revision, Gasteiger charge sums for ammonium
and acetate are approximately zero even though their formal molecular charges
are nonzero.
