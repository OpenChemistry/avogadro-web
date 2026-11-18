// SPDX-License-Identifier: BSD-3-Clause
#ifndef AVOGADROWEB_ROUNDTRIPPROPERTIES_H
#define AVOGADROWEB_ROUNDTRIPPROPERTIES_H

#include <QString>
#include <random>

namespace Avogadro::Web {
class WebController;
}

// Returns a diagnostic when a generated neutral molecule fails a round trip.
QString checkGeneratedRoundTrip(Avogadro::Web::WebController& editor,
                                std::mt19937& random);

#endif
