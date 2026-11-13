# Workspace redesign validation — 14 November 2026

Implemented in an isolated worktree on `codex/polished-workspace`, based on
`timvdm/master` at `f8987cf`. The original checkout and its uncommitted
restructuring were preserved. Nothing was pushed or deployed.

The first pass used the unchanged CI artifact from run `43511417867`:
Chromium's 11 core checks, Firefox's eight checks, three startup failure cases,
and seven workspace UI checks passed. That artifact only exposes the three
original tools and no canvas-theme binding.

At the user's subsequent request, a new runtime was built against the existing
plugin-enabled WASM Avogadro installation at `/tmp/avo-web-plugins/prefix`.
Avogadrolibs itself was reused, not rebuilt in this task. The new runtime uses
Qt 6.11.1 multithreaded WASM and Emscripten 4.0.7, with browser test hooks enabled.
The missing locked Emscripten JavaScript dependencies were restored with
`npm ci --omit=dev --ignore-scripts --no-audit --no-fund` in the SDK directory.

Results for the new runtime:

- Native controller: 11 GoogleTest cases passed, including theme changes leaving
  document contents, modified state, and undo history unchanged.
- Chromium: 24 checks passed, covering all nine tools, five molecular display
  styles plus surface rendering, UFF optimization and undo, AutoOptimize,
  three molecular surfaces, FCHK/Molden orbitals, electron density, imported
  cube rendering, file handling, camera input and external QWidget redraws.
- Firefox: eight core editing/import/export checks passed on an isolated Xvfb
  display. Headless Firefox lacked WebGL2; the isolated-display run succeeded.
- Workspace UI: eight checks passed, including runtime capabilities, persistent
  theme selection, unchanged document state, responsive panels, keyboard tabs,
  runtime exit, loading and startup errors.
- Screenshots reviewed in dark and light at 1440×900, 1024×768 and 768×1024,
  with empty/populated views, labels, loading, failures and confirmation dialogs.
- Pixel comparisons initially captured queued redraws too early. The rendering
  test now requires three consecutive identical frames before comparing images.

Build and test commands (from `/home/timvdm/openchemistry`):

```sh
source /home/timvdm/emsdk/emsdk_env.sh
export EM_CACHE=/tmp/avogadro-ui-em-cache
/home/timvdm/Qt/6.11.1/wasm_multithread/bin/qt-cmake \
  -S /home/timvdm/openchemistry/avogadro-web-ui -B /tmp/avogadro-ui-build -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DAvogadroLibs_DIR=/tmp/avo-web-plugins/prefix/lib/cmake/avogadrolibs \
  -DEigen3_DIR=/home/timvdm/openchemistry/build-web/prefix/share/eigen3/cmake \
  -DQT_HOST_PATH=/home/timvdm/Qt/6.11.1/gcc_64 -DENABLE_TESTING=ON
cmake --build /tmp/avogadro-ui-build --parallel 4
cmake --install /tmp/avogadro-ui-build \
  --prefix /home/timvdm/openchemistry/avogadro-web-ui/build/stage

cmake -S avogadro-web-ui -B /tmp/avogadro-ui-native -G Ninja \
  -DAvogadroLibs_DIR=/tmp/avo-review/static-prefix/lib/cmake/avogadrolibs \
  '-DCMAKE_PREFIX_PATH=/home/timvdm/Qt/6.11.1/gcc_64;/home/timvdm/openchemistry/build-native/prefix' \
  -DENABLE_TESTING=ON
cmake --build /tmp/avogadro-ui-native --parallel 4
ctest --test-dir /tmp/avogadro-ui-native --output-on-failure

AVOGADRO_FCHK_FIXTURE=/home/timvdm/openchemistry/avogadrodata/data/fchk/h2o-restricted.fchk \
  node avogadro-web-ui/tests/browser-smoke.mjs http://127.0.0.1:8767 \
  /tmp/avogadro-ui-evidence/full-chromium-settled --plugins --widget-update

export PUPPETEER_MODULE=/tmp/avogadro-ui-test-deps/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js
DISPLAY=:97 node avogadro-web-ui/tests/firefox-smoke.mjs \
  http://127.0.0.1:8767 /tmp/avogadro-ui-evidence/full-firefox
AVOGADRO_UI_FIXTURE=/tmp/avogadro-caffeine-2519.sdf \
  node avogadro-web-ui/tests/ui-smoke.mjs http://127.0.0.1:8767 \
  /tmp/avogadro-ui-evidence/full-ui --full-runtime
node avogadro-web-ui/tests/startup-failures.mjs \
  /home/timvdm/openchemistry/avogadro-web-ui/build/stage/share/avogadro-web
node --check avogadro-web-ui/editor.js
node --check avogadro-web-ui/tests/ui-smoke.mjs
node --check avogadro-web-ui/tests/browser-smoke.mjs
git -C avogadro-web-ui diff --check
```

Local artifacts are in `build/stage/share/avogadro-web`; screenshots and test
results are in `build/evidence`. Both directories are ignored by Git.
The full native desktop suite and sanitizers were not rerun for this UI change.
The runtime includes browser-supported features; Python and subprocess plugins
remain outside the WASM profile.

---

# Implementation validation — 25 September 2026

This is the historical validation record from before extraction into
`avogadro-web`. Paths below refer to the original layout; use README.md for
current build and test commands. These results do not validate the extraction.

Validation ran locally from `/home/timvdm/openchemistry`. Existing archives,
`avogadro-wasm/`, `build-wasm/`, unrelated submodule changes and commit history
were preserved. Nothing was published.

## Results

| Check | Result |
| --- | --- |
| Native default superbuild, Qt 6.11.1 | Built libraries and desktop executable |
| Native `ENABLE_SUBPROCESS=OFF` | Built libraries and desktop executable |
| WASM web profile, Qt 6.11.1 multithreaded / Emscripten 4.0.7 | Built and installed |
| Native default Core/Io/QtGui/Rendering | 47/47 CTest entries passed |
| Native subprocess-disabled Core/Io/QtGui/Rendering | 46/46 passed |
| Native web-profile Core/Io/QtGui/Rendering | 46/46 passed |
| Web controller regression executable | All seven GoogleTest cases passed |
| Address, undefined-behavior and leak sanitizers | All seven controller/Draw cases passed with instrumented Avogadro libraries |
| Chromium | Startup, Draw/hydrogens, undo/redo, discard/cancel, navigation guard, settings, selection/deletion, HTML focus, browser file input, malformed import, four downloads, camera and resize passed |
| Firefox 154 | Startup, Draw/hydrogens, bond dragging, selection/deletion, undo/redo, HTML focus, rotate/pan/zoom/fit/resize, multi-record notice, malformed import and four export payloads passed |
| Startup failure states | Missing isolation headers, unavailable WebGL2 and missing WASM asset displayed errors with controls disabled |
| Native viewport | Started with a valid OpenGL context on private Xvfb display |
| Native desktop | Started with temporary settings; remained alive after activating Draw |
| Generated dependencies and installed exports | Only Navigator, Editor, Selection and BallStick plugins; disabled subprocess sources/headers/exports, libarchive, plotting and RPC absent |
| Incompatible WASM configuration requests | Eight explicit incompatible requests rejected with option-specific errors |
| Static checks | cppcheck and clang-tidy completed; details below |

The controller tests cover lazy panel creation and disposal, two-way option
synchronization, defaults, invalid settings/tool lookup, unchanged hydrogen
adjustment, single/double/triple bonds, grouped undo/redo, file round trips,
first-record notices, failed-import preservation, save state and repeated
release of document layer state.

## Build and test commands

The following abbreviations identify the exact local tool locations used:

```sh
CMAKE=/home/timvdm/Qt/Tools/CMake/bin/cmake
CTEST=/home/timvdm/Qt/Tools/CMake/bin/ctest
NINJA=/home/timvdm/Qt/Tools/Ninja/ninja
QT_NATIVE=/home/timvdm/Qt/6.11.1/gcc_64
```

Native default configuration and build:

```sh
$CMAKE -S . -B build-native -G Ninja -DCMAKE_MAKE_PROGRAM="$NINJA" \
  -DQt6_DIR="$QT_NATIVE/lib/cmake/Qt6" -DCMAKE_BUILD_TYPE=Release
CMAKE_BUILD_PARALLEL_LEVEL=4 $CMAKE --build build-native -j2
$CMAKE -S avogadrolibs -B build-native/avogadrolibs -DENABLE_TESTING=ON
$CMAKE --build build-native/avogadrolibs -j4
QT_QPA_PLATFORM=offscreen XDG_CONFIG_HOME="$PWD/build-native/test-config" \
  LD_LIBRARY_PATH="$QT_NATIVE/lib:$PWD/build-native/prefix/lib" \
  $CTEST --test-dir build-native/avogadrolibs --output-on-failure \
  -R '^(Core|Io|QtGui|Rendering)-'
```

Native subprocess-disabled libraries and desktop, using the newly built native
dependencies:

```sh
$CMAKE -S avogadrolibs -B build-native-nosubprocess/libs -G Ninja \
  -DCMAKE_MAKE_PROGRAM="$NINJA" \
  -DCMAKE_PREFIX_PATH="$PWD/build-native/prefix;$QT_NATIVE" \
  -DCMAKE_INSTALL_PREFIX="$PWD/build-native-nosubprocess/prefix" \
  -DCMAKE_BUILD_TYPE=Release -DENABLE_SUBPROCESS=OFF \
  -DENABLE_TESTING=ON -DCMAKE_EXPORT_COMPILE_COMMANDS=ON
$CMAKE --build build-native-nosubprocess/libs -j4
$CMAKE --install build-native-nosubprocess/libs
$CMAKE -S avogadroapp -B build-native-nosubprocess/app -G Ninja \
  -DCMAKE_MAKE_PROGRAM="$NINJA" -DQT_VERSION=6 -DBUILD_SHARED_LIBS=ON \
  -DCMAKE_PREFIX_PATH="$PWD/build-native-nosubprocess/prefix;$PWD/build-native/prefix;$QT_NATIVE" \
  -DCMAKE_BUILD_TYPE=Release
$CMAKE --build build-native-nosubprocess/app -j4
QT_QPA_PLATFORM=offscreen $CTEST --test-dir build-native-nosubprocess/libs \
  --output-on-failure -R '^(Core|Io|QtGui|Rendering)-'
```

The native web profile uses the same direct-project commands, replacing
`build-native-nosubprocess` with `build-native-web`, using `RelWithDebInfo`, and
adding `-DAVOGADRO_WEB_EDITOR=ON` to both projects and `-DENABLE_TESTING=ON` to the
app. Its additional test command is:

```sh
QT_QPA_PLATFORM=offscreen $CTEST --test-dir build-native-web/app --output-on-failure
```

WASM configuration/build used a workspace-local copy of the installed SDK and
cache because the installed cache was read-only. The SDK's missing `acorn`
package was supplied in that copy; no installed SDK files were modified.
Previously downloaded third-party archives were reused in the fresh builds.

```sh
export EMSDK="$PWD/build-web/sdk"
export EM_CACHE="$PWD/build-web/em-cache"
/home/timvdm/Qt/6.11.1/wasm_multithread/bin/qt-cmake -S . -B build-web \
  -G Ninja -DCMAKE_MAKE_PROGRAM="$NINJA" -DCMAKE_BUILD_TYPE=Release \
  -DQT_HOST_PATH="$QT_NATIVE" \
  -DQT_CHAINLOAD_TOOLCHAIN_FILE="$EMSDK/upstream/emscripten/cmake/Modules/Platform/Emscripten.cmake"
CMAKE_BUILD_PARALLEL_LEVEL=4 $CMAKE --build build-web -j2
$CMAKE --install build-web/avogadroapp --prefix "$PWD/build-web/stage"
python3 avogadroapp/web/tests/check-build-profile.py build-web
```

Fresh configurations under `build-web/configuration-checks/` were run with the
same Qt/WASM configure arguments and one override at a time:
`ENABLE_SUBPROCESS=ON`, `USE_LIBARCHIVE=ON`, `USE_PYTHON=ON`, `USE_PLOTTER=ON`,
`Avogadro_ENABLE_RPC=ON`, `BUILD_STATIC_PLUGINS=OFF`, `BUILD_SHARED_LIBS=ON`, and
`AVOGADRO_WEB_EDITOR=OFF`. Every command returned nonzero and named the offending
option. Logs are kept in that directory.

Browser checks, with a loopback `serve-wasm.py` process serving the application:

```sh
node avogadroapp/web/tests/browser-smoke.mjs http://127.0.0.1:8000 build-web/browser-evidence
export PUPPETEER_MODULE=/tmp/avogadro-node/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js
PATH=/tmp/avogadro-qa-tools/root/usr/bin:$PATH LIBGL_ALWAYS_SOFTWARE=1 \
  xvfb-run -a -s '-screen 0 1280x900x24 -nolisten tcp' \
  node avogadroapp/web/tests/firefox-smoke.mjs http://127.0.0.1:8000 build-web/firefox-evidence
node avogadroapp/web/tests/startup-failures.mjs build-web/stage/share/avogadro-web
```

Screenshots and JSON results are in `build-web/browser-evidence/` and
`build-web/firefox-evidence/`. Tests own fresh browser profiles. Xvfb and
clang-tidy were extracted from Ubuntu packages into `/tmp`; no system packages
were installed. Puppeteer Core 25.12.0 was installed in `/tmp` with package
scripts disabled. Native GUI checks explicitly selected `QT_QPA_PLATFORM=xcb`,
`QT_XCB_GL_INTEGRATION=xcb_glx` and `LIBGL_ALWAYS_SOFTWARE=1` on private Xvfb
displays. The viewport used `build-native-web/app/bin/avogadro-web --smoke-test`;
the desktop check activated Ctrl+2 with `xdotool` and checked process liveness.
Native Draw panel synchronization is additionally checked by the regression
executable.

## Sanitizers and static analysis

The `build-native-sanitize/libs` and `app` directories were configured like the
native web profile, using Debug and
`-DCMAKE_CXX_FLAGS=-fsanitize=address,undefined -fno-omit-frame-pointer` (and the
same C flags for libraries). All Avogadro libraries were instrumented; external
Qt and dependency binaries were not rebuilt with sanitizers.

```sh
ASAN_OPTIONS=detect_leaks=0 $CMAKE --build build-native-sanitize/libs -j4
$CMAKE --install build-native-sanitize/libs
ASAN_OPTIONS=detect_leaks=0 $CMAKE --build build-native-sanitize/app -j4
QT_QPA_PLATFORM=offscreen ASAN_OPTIONS=detect_leaks=1 \
  UBSAN_OPTIONS=print_stacktrace=1:halt_on_error=1 \
  $CTEST --test-dir build-native-sanitize/app --output-on-failure
```

Leak detection was disabled only while executing build-time host tools inside
the ptrace-restricted sandbox. The regression test ran outside that restriction
with leak detection enabled and reported no sanitizer errors or leaks.

```sh
cppcheck --enable=warning,performance,portability --std=c++17 \
  --suppress=missingIncludeSystem --inline-suppr -Dslots= -Dsignals=public \
  -DQ_OBJECT= -DQ_EMIT= -Demit= avogadroapp/web/main.cpp \
  avogadroapp/web/webcontroller.cpp avogadrolibs/avogadro/qtplugins/editor/editor.cpp \
  avogadrolibs/avogadro/qtplugins/editor/editortoolwidget.cpp \
  avogadrolibs/avogadro/rendering/shaderprogram.cpp
/tmp/avogadro-qa-tools/root/usr/bin/clang-tidy-18 -p build-native-web/app \
  avogadroapp/web/webcontroller.cpp avogadroapp/web/main.cpp
/tmp/avogadro-qa-tools/root/usr/bin/clang-tidy-18 -p build-native-web/libs \
  avogadrolibs/avogadro/qtplugins/editor/editor.cpp \
  avogadrolibs/avogadro/qtplugins/editor/editortoolwidget.cpp \
  avogadrolibs/avogadro/rendering/shaderprogram.cpp
```

Static analysis found and prompted fixes for missing-factory lookup and null
pointer arithmetic in GL buffer offsets. No application-source warnings remain
in the controller/main clang-tidy run. The existing library style configuration
still reports inherited initialization/style warnings, the const cast required
by the existing const `toolWidget()` interface, and the GL buffer-offset cast.
cppcheck reports the existing virtual `setIcon()` call in the Editor constructor.
These are not reported as a clean, warning-free analysis run.

## Artifacts and remaining limits

The release WASM is approximately 16.8 MB (6.15 MB gzip), with about 251 KB of
Emscripten JavaScript and 12 KB of Qt loader JavaScript. Exact final sizes and
SHA-256 hashes are recorded in `build-web/release-info.json` beside the archive.
The fresh stage is `build-web/stage/share/avogadro-web/`.

Browser checks used software rendering, not a hardware GPU. Safari, tablets,
mobile devices, production HTTPS hosting, and browser-native navigation prompt
UI were not exercised. `beforeunload` event cancellation passed its regression check, but browser
policies control whether its prompt appears. The full native Qt package tests
and unrelated quantum/force-field suites were not run. The native desktop needs
the selected Qt 6.11.1 runtime on its library path when the host also has an
incompatible system Qt. Publishing remains outside this work.
