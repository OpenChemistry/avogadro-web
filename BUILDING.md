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

## Local Qt 6.12 and Emscripten 5.0.5 trial

The release pins remain Qt 6.11.1 and Emscripten 4.0.7. Qt pairs its 6.12.0
WASM packages with Emscripten 5.0.5. Use a separate SDK installation, the
matching Qt 6.12.0 host tools and both WASM kits to repeat the trial.
[Qt for WebAssembly](https://doc.qt.io/qt-6.12/wasm.html)

The trial used OpenChemistry `b563eb581623e0c3b16fe72ba33033a0441ba4d2`,
avogadrolibs `61ce6da07f2a125fae2a26180f9c8addad381672`, and avogadro-web
`fccf68b0cb961acc1aa615dd7b035e7cde4c0143`. Use those revisions in a
separate checkout to reproduce the measured packages. The commands below
take the installed SDK and kit paths explicitly. Each kit gets an empty build
and staging directory.

```bash
set -eo pipefail
source_dir=/absolute/path/to/openchemistry
emsdk_root=/absolute/path/to/emsdk-5.0.5
qt_host=/absolute/path/to/Qt/6.12.0/gcc_64
qt_single=/absolute/path/to/Qt/6.12.0/wasm_singlethread
qt_multi=/absolute/path/to/Qt/6.12.0/wasm_multithread
trial_root=$(mktemp -d "${TMPDIR:-/tmp}/avogadro-qt612.XXXXXX")

"$emsdk_root/emsdk" install 5.0.5
"$emsdk_root/emsdk" activate 5.0.5
source "$emsdk_root/emsdk_env.sh"
em++ --version
"$qt_host/libexec/moc" --version
export CMAKE_BUILD_PARALLEL_LEVEL=2

for kit in wasm_singlethread wasm_multithread; do
  qt_wasm=$qt_single
  if [[ $kit == wasm_multithread ]]; then qt_wasm=$qt_multi; fi
  build="$trial_root/$kit"
  cmake -S "$source_dir" -B "$build" -G Ninja \
    -DCMAKE_TOOLCHAIN_FILE="$qt_wasm/lib/cmake/Qt6/qt.toolchain.cmake" \
    -DCMAKE_BUILD_TYPE=Release -DQT_HOST_PATH="$qt_host" \
    -DQT_CHAINLOAD_TOOLCHAIN_FILE="$EMSDK/upstream/emscripten/cmake/Modules/Platform/Emscripten.cmake" \
    -DAVOGADRO_WEB_EDITOR=ON -DBUILD_AVOGADRO=ON -DUSE_OPENGL=ON \
    -DBUILD_SHARED_LIBS=OFF -DBUILD_STATIC_PLUGINS=ON -DENABLE_SUBPROCESS=OFF \
    -DUSE_PYTHON=OFF -DUSE_LIBARCHIVE=OFF -DUSE_PLOTTER=OFF -DBUILD_MOLEQUEUE=OFF \
    -DAvogadro_ENABLE_RPC=OFF -DENABLE_TESTING=OFF
  cmake --build "$build" --parallel 2
  python3 "$source_dir/avogadro-web/tests/check-build-profile.py" "$build" "$kit"
  cmake --install "$build/avogadro-web" --prefix "$build/stage"
done
```

Install the browser test dependencies with `npm ci --ignore-scripts --no-audit
--no-fund` in `"$source_dir/avogadro-web/tests/browser"`. Use the loopback
server commands in [Build](#build) from the corresponding package directory.
Run the test commands below in a second terminal with the same `source_dir`
and `trial_root` values. Stop the single-threaded server before starting the
isolated multithreaded server on port 8000.

```bash
tests="$source_dir/avogadro-web/tests/browser"
single="$trial_root/wasm_singlethread/stage/share/avogadro-web"
multi="$trial_root/wasm_multithread/stage/share/avogadro-web"
node "$tests/startup-failures.mjs" "$single" --single-threaded
node "$tests/startup-failures.mjs" "$multi"

# With the single-threaded package served by python3 -m http.server.
node "$tests/browser-smoke.mjs" http://127.0.0.1:8000/ "$trial_root/single-hosted"
mkdir "$trial_root/offline"
cp "$single/avogadro-offline.html" "$trial_root/offline/"
node "$tests/browser-smoke.mjs" "file://$trial_root/offline/avogadro-offline.html" "$trial_root/single-offline"

# With the multithreaded package served by its serve-wasm.py.
export AVOGADRO_FCHK_FIXTURE="$source_dir/avogadrodata/data/fchk/h2o-restricted.fchk"
for run in 1 2; do
  node "$tests/browser-smoke.mjs" http://127.0.0.1:8000/ "$trial_root/multi-hosted-$run"
done
```

Both release builds passed the build-profile check. Chromium passed
single-threaded startup in a cross-origin iframe without isolation, hosted
smoke (11 checks), and direct file startup and editing (12 checks).
The isolated threaded build passed 15 smoke checks in each of two browser
runs, including UFF optimization, surfaces, orbitals, and imported grids.
The checks did not measure startup time or reproduce the reported threaded
hang. The trial predates the editor CSP and its stylesheet hash checks.
[Threaded hang report](https://github.com/OpenChemistry/avogadro-web/issues/17)

The default-column values are from the PR #21 CI artifacts
(Qt 6.11.1/Emscripten 4.0.7, editor `ecae4c178ff00c7c5344b5341a01898387b89c7d`).
The candidate was built locally with Qt 6.12.0/Emscripten 5.0.5. The artifact
comparison includes differences in the editor revision and build environment.
[PR #21](https://github.com/OpenChemistry/avogadro-web/pull/21) · CI run `44391559047`

| Kit | Asset | Default bytes | Candidate bytes | Release budget |
| --- | --- | ---: | ---: | ---: |
| Single | WASM | 16,424,523 | 20,461,332 | 18,874,368 |
| Single | WASM gzip | 5,970,236 | 7,049,098 | 6,815,744 |
| Single | Offline HTML | 8,385,119 | 9,782,311 | 9,437,184 |
| Threaded | WASM | 17,553,200 | 21,565,393 | 19,922,944 |
| Threaded | WASM gzip | 6,435,622 | 7,515,262 | 7,340,032 |

After staging, create each local ZIP with `python3 -m zipfile -c
"$trial_root/$kit.zip" .` from the package directory. Run
`python3 tools/check-wasm-size.py KIT STAGED_PACKAGE ZIP` from this checkout against
the resulting package. The single-threaded local ZIP was 21,430,800 bytes
(20,971,520 budget) and the threaded ZIP was 15,185,957 bytes (15,728,640
budget). The checker rejected both kits because of the over-budget assets.
The release pins remain in place pending a controlled size comparison and a
test that reproduces the threaded hang on the default toolchain.

## Continuous integration

The release workflow builds both kits using `tools/wasm-toolchain.json`.
The companion avogadrolibs workflow reads the same file from the editor's
main branch. Enable that job with an upstream superbuild revision that
contains the published companion pins.

Each WASM job uploads its release ZIP, a separate test-hook build linked
against the same library installation, and a JSON size report. Release
assets must fit the kit budgets in `tools/wasm-size-budgets.json`. Update a
budget alongside an intentional size increase and record both measurements.
The continuous download and Pages deployment consume only the release ZIPs
and run from the upstream main branch.

Native CI runs the controller suite with address and undefined-behavior
sanitizers and checks the web C++ sources with clang-tidy. The
`WebEditorRoundTrips` test builds small neutral molecules from a fixed seed
and verifies atom identities and coordinate precision after CJSON, MOL, SDF
and XYZ round trips. It also checks bond connectivity and order for the
three formats that store bonds. The default run uses 64
molecules. Nightly CI uses 2,048, which can be reproduced locally with
`AVOGADRO_ROUND_TRIP_CASES=2048 ctest --test-dir build-native -R WebEditorRoundTrips --output-on-failure`.

The native Clang build can also enable the libFuzzer driver with
`-DENABLE_ROUND_TRIP_FUZZER=ON`. The driver uses up to four bytes as a seed
for the neutral molecule generator and runs the same checks as CTest.
CI performs 64 runs on PRs and pushes and 2,048 runs nightly. In an
existing native Clang build with the option enabled, use the command below.
Qt’s minimal platform avoids the system font database during this test.

```sh
QT_QPA_PLATFORM=minimal build-native/bin/AvogadroWebRoundTripFuzzer \
  -runs=64 -max_len=4 -max_total_time=90 -seed=1729 -exact_artifact_path=/dev/null
```

The browser import corpus checks small standard molecule files and
failed-import preservation against both release packages. Its nightly run repeats the same bounded
cases. Repository maintainers can require the lint, native, WASM and
dependency review checks in branch protection after a successful run.

The library revision pinned in CI includes the headless action plugins from
[avogadrolibs PR #3377](https://github.com/OpenChemistry/avogadrolibs/pull/3377).
For matching local builds, use `--action-plugins` with both
`tests/check-build-profile.py` and `tests/browser/browser-smoke.mjs`.
