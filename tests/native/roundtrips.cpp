// SPDX-License-Identifier: BSD-3-Clause
#include "roundtripproperties.h"
#include "webcontroller.h"

#include <avogadro/qtopengl/glwidget.h>
#include <gtest/gtest.h>

#include <algorithm>

namespace {
TEST(GeneratedRoundTrips, PreservesElementsCoordinatesAndSupportedBonds)
{
  constexpr int defaultCases = 64;
  constexpr int maximumCases = 2048;
  bool countValid = false;
  const int requestedCases =
    qEnvironmentVariableIntValue("AVOGADRO_ROUND_TRIP_CASES", &countValid);
  const int count =
    countValid ? std::clamp(requestedCases, 1, maximumCases) : defaultCases;
  constexpr unsigned seed = 1729;
  std::mt19937 random(seed);
  Avogadro::QtOpenGL::GLWidget view;
  Avogadro::Web::WebController editor(view);

  for (int index = 0; index < count; ++index) {
    SCOPED_TRACE(::testing::Message() << "seed " << seed << ", case " << index);
    const auto error = checkGeneratedRoundTrip(editor, random);
    ASSERT_TRUE(error.isEmpty()) << error.toStdString();
  }
}
} // namespace
