// SPDX-License-Identifier: BSD-3-Clause
#include "roundtripproperties.h"
#include "webcontroller.h"

#include <QApplication>
#include <avogadro/qtopengl/glwidget.h>

#include <cstddef>
#include <cstdint>
#include <cstdlib>

namespace {
struct Harness
{
  int argc = 1;
  char name[sizeof("AvogadroWebRoundTripFuzzer")] =
    "AvogadroWebRoundTripFuzzer";
  char* argv[2] = { name, nullptr };
  QApplication application{ argc, argv };
  Avogadro::QtOpenGL::GLWidget view;
  Avogadro::Web::WebController editor{ view };
};

void runRoundTrip(std::uint32_t seed)
{
  static Harness harness;
  std::mt19937 random(seed);
  const auto error = checkGeneratedRoundTrip(harness.editor, random);
  if (!error.isEmpty()) {
    qCritical("Generated round trip failed: %s", qPrintable(error));
    std::abort();
  }
  QCoreApplication::processEvents();
}
} // namespace

extern "C" int LLVMFuzzerInitialize(int*, char***)
{
  // Prime Qt's process-wide font and widget state before measuring each case.
  runRoundTrip(0);
  return 0;
}

extern "C" int LLVMFuzzerTestOneInput(const std::uint8_t* data,
                                      std::size_t size)
{
  if (size > sizeof(std::uint32_t))
    return 0;

  // Use the bounded input solely as a seed for the neutral molecule generator.
  std::uint32_t seed = 0;
  for (std::size_t i = 0; i < size; ++i)
    seed |= static_cast<std::uint32_t>(data[i]) << (8 * i);

  runRoundTrip(seed);
  return 0;
}
