#!/usr/bin/env bash
# Native CI builds the pinned libraries and controller in independent trees.
set -euo pipefail

case "$1" in
  libraries)
    cmake -S dependencies/avogadrolibs -B build-libraries -G Ninja \
      -DCMAKE_BUILD_TYPE=Debug -DCMAKE_INSTALL_PREFIX="$PWD/native-prefix" \
      -DBUILD_STATIC_PLUGINS=ON -DBUILD_SHARED_LIBS=OFF -DUSE_OPENGL=ON \
      -DUSE_SUBPROCESS=OFF -DUSE_LIBARCHIVE=OFF -DUSE_PLOTTER=OFF \
      -DUSE_LIBMSYM=OFF -DUSE_SPGLIB=OFF
    cmake --build build-libraries --parallel 2
    cmake --install build-libraries
    ;;
  controller)
    cmake -S . -B build-native -G Ninja \
      -DCMAKE_BUILD_TYPE=Debug -DCMAKE_PREFIX_PATH="$PWD/native-prefix" \
      -DENABLE_TESTING=ON -DCMAKE_EXPORT_COMPILE_COMMANDS=ON \
      -DENABLE_ROUND_TRIP_FUZZER="${ENABLE_ROUND_TRIP_FUZZER:-OFF}"
    cmake --build build-native --parallel 2
    ;;
  *)
    printf 'Usage: %s libraries|controller\n' "$0" >&2
    exit 2
    ;;
esac
