// SPDX-License-Identifier: BSD-3-Clause
#include "roundtripproperties.h"
#include "webcontroller.h"

#include <QJsonArray>
#include <QJsonDocument>
#include <avogadro/core/atom.h>
#include <avogadro/core/bond.h>
#include <avogadro/qtgui/molecule.h>

#include <algorithm>
#include <array>
#include <cmath>
#include <vector>

namespace {
using Bond = std::array<int, 3>;

struct Atom
{
  int element;
  std::array<double, 3> position;
};

struct Molecule
{
  std::vector<Atom> atoms;
  std::vector<Bond> bonds;
};

Molecule makeMolecule(std::mt19937& random)
{
  constexpr std::array<int, 3> elements{ 6, 7, 8 };
  constexpr std::array<int, 3> valences{ 4, 3, 2 };
  constexpr std::array<std::array<double, 2>, 4> hydrogenOffsets{
    { { 1.0, 0.0 }, { -1.0, 0.0 }, { 0.0, 1.0 }, { 0.0, -1.0 } }
  };

  const int heavyAtoms = 1 + random() % 4;
  Molecule molecule;
  std::array<int, 4> remainingValence{};
  for (int index = 0; index < heavyAtoms; ++index) {
    const auto type = random() % elements.size();
    molecule.atoms.push_back(
      { elements[type], { 1.5 * index, 0.25 * (index % 2), 0.0 } });
    remainingValence[index] = valences[type];
  }

  // Reserve a single bond for each link before choosing any double bonds.
  for (int index = 1; index < heavyAtoms; ++index) {
    molecule.bonds.push_back({ index - 1, index, 1 });
    --remainingValence[index - 1];
    --remainingValence[index];
  }
  for (auto& [first, second, order] : molecule.bonds) {
    if (remainingValence[first] && remainingValence[second] && random() % 2) {
      ++order;
      --remainingValence[first];
      --remainingValence[second];
    }
  }
  for (int index = 0; index < heavyAtoms; ++index) {
    const auto position = molecule.atoms[index].position;
    for (int hydrogen = 0; hydrogen < remainingValence[index]; ++hydrogen) {
      const auto [dy, dz] = hydrogenOffsets[hydrogen];
      const int nextAtom = static_cast<int>(molecule.atoms.size());
      molecule.atoms.push_back(
        { 1, { position[0], position[1] + dy, position[2] + dz } });
      molecule.bonds.push_back({ index, nextAtom, 1 });
    }
  }
  std::sort(molecule.bonds.begin(), molecule.bonds.end());
  return molecule;
}

QString toCjson(const Molecule& molecule)
{
  QJsonArray elements;
  QJsonArray coordinates;
  for (const auto& atom : molecule.atoms) {
    elements.append(atom.element);
    for (double coordinate : atom.position)
      coordinates.append(coordinate);
  }

  QJsonArray endpoints;
  QJsonArray orders;
  for (const auto& [first, second, order] : molecule.bonds) {
    endpoints.append(first);
    endpoints.append(second);
    orders.append(order);
  }

  const QJsonObject atoms{ { "elements",
                             QJsonObject{ { "number", elements } } },
                           { "coords", QJsonObject{ { "3d", coordinates } } } };
  const QJsonObject bonds{ { "connections",
                             QJsonObject{ { "index", endpoints } } },
                           { "order", orders } };
  return QString::fromUtf8(QJsonDocument(QJsonObject{ { "chemicalJson", 1 },
                                                      { "atoms", atoms },
                                                      { "bonds", bonds } })
                             .toJson(QJsonDocument::Compact));
}

QString checkRoundTrip(const Avogadro::QtGui::Molecule& actual,
                       const Molecule& expected, bool storesBonds)
{
  if (actual.atomCount() != expected.atoms.size())
    return QStringLiteral("atom count changed");

  for (std::size_t index = 0; index < expected.atoms.size(); ++index) {
    const auto atom = actual.atom(index);
    if (atom.atomicNumber() != expected.atoms[index].element)
      return QStringLiteral("element changed at atom %1").arg(index);
    for (int axis = 0; axis < 3; ++axis) {
      const auto error = std::abs(atom.position3d()[axis] -
                                  expected.atoms[index].position[axis]);
      if (!std::isfinite(error) || error > 0.0001)
        return QStringLiteral("position changed at atom %1, axis %2")
          .arg(index)
          .arg(axis);
    }
  }

  if (!storesBonds)
    return {};
  if (actual.bondCount() != expected.bonds.size())
    return QStringLiteral("bond count changed");

  std::vector<Bond> bonds;
  for (std::size_t index = 0; index < actual.bondCount(); ++index) {
    const auto bond = actual.bond(index);
    const auto first = static_cast<int>(bond.atom1().index());
    const auto second = static_cast<int>(bond.atom2().index());
    bonds.push_back(
      { (std::min)(first, second), (std::max)(first, second), bond.order() });
  }
  std::sort(bonds.begin(), bonds.end());
  if (bonds != expected.bonds)
    return QStringLiteral("bond connectivity or order changed");
  return {};
}
} // namespace

QString checkGeneratedRoundTrip(Avogadro::Web::WebController& editor,
                                std::mt19937& random)
{
  const auto molecule = makeMolecule(random);
  const auto cjson = toCjson(molecule);
  for (const QString format : { "cjson", "mol", "sdf", "xyz" }) {
    const auto initial = editor.loadMolecule(cjson, "cjson");
    if (!initial["ok"].toBool())
      return QStringLiteral("Loading generated CJSON: ") +
             initial["error"].toString();
    const auto saved = editor.exportMolecule(format);
    if (!saved["ok"].toBool())
      return QStringLiteral("Exporting ") + format + ": " +
             saved["error"].toString();
    const auto loaded = editor.loadMolecule(saved["text"].toString(), format);
    if (!loaded["ok"].toBool())
      return QStringLiteral("Reloading ") + format + ": " +
             loaded["error"].toString();
    const auto error =
      checkRoundTrip(editor.molecule(), molecule, format != "xyz");
    if (!error.isEmpty())
      return format + ": " + error;
  }
  return {};
}
