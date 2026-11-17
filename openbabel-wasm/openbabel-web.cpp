// SPDX-License-Identifier: GPL-2.0-or-later
// The same entry point builds as a native reference and an independent WASM
// module.
#include "stereo/gen3dstereohelper.h"
#include <cmath>
#include <cstdlib>
#include <iomanip>
#include <iostream>
#include <iterator>
#include <openbabel/atom.h>
#include <openbabel/builder.h>
#include <openbabel/chargemodel.h>
#include <openbabel/forcefield.h>
#include <openbabel/mol.h>
#include <openbabel/obconversion.h>
#include <sstream>
#ifdef __EMSCRIPTEN__
#include <emscripten/bind.h>
#endif

namespace {
std::string jsonString(const std::string& value)
{
  std::ostringstream result;
  result << '"';
  for (unsigned char character : value) {
    switch (character) {
      case '"':
        result << "\\\"";
        break;
      case '\\':
        result << "\\\\";
        break;
      case '\n':
        result << "\\n";
        break;
      case '\r':
        result << "\\r";
        break;
      case '\t':
        result << "\\t";
        break;
      default:
        if (character < 0x20)
          result << "\\u" << std::hex << std::setw(4) << std::setfill('0')
                 << static_cast<unsigned int>(character);
        else
          result << character;
    }
  }
  result << '"';
  return result.str();
}
}

std::string generate3DFromSmiles(const std::string& input)
{
  const auto begin = input.find_first_not_of(" \t\r\n");
  if (begin == std::string::npos)
    return R"({"ok":false,"error":"Enter a SMILES string."})";
  const auto smiles =
    input.substr(begin, input.find_last_not_of(" \t\r\n") - begin + 1);
  if (smiles.find_first_of(" \t\r\n") != std::string::npos)
    return R"({"ok":false,"error":"Enter one SMILES string without a title or additional lines."})";

  setenv("BABEL_DATADIR", OPENBABEL_DATA_DIR, 1);
  OpenBabel::OBConversion conversion;
  OpenBabel::OBMol molecule;
  if (!conversion.SetInAndOutFormats("smi", "mol") ||
      !conversion.ReadString(&molecule, smiles) || molecule.NumAtoms() == 0)
    return R"({"ok":false,"error":"Unable to parse this SMILES string."})";

  OpenBabel::OBGen3DStereoHelper stereo;
  stereo.Setup(&molecule);
  OpenBabel::OBBuilder builder;
  if (!builder.Build(molecule) || !molecule.AddHydrogens())
    return R"({"ok":false,"error":"Open Babel could not generate 3D coordinates for this SMILES."})";
  auto* forceField = OpenBabel::OBForceField::FindForceField("UFF");
  if (!forceField)
    return R"({"ok":false,"error":"The Open Babel UFF plugin is unavailable."})";
  const bool optimized = forceField->Setup(molecule);
  if (optimized) {
    forceField->ConjugateGradients(200, 1.0e-6);
    if (!forceField->GetCoordinates(molecule) ||
        !std::isfinite(forceField->Energy()))
      return R"({"ok":false,"error":"Open Babel could not relax the generated coordinates."})";
  }
  if (!stereo.Check(&molecule))
    return R"({"ok":false,"error":"Open Babel could not preserve the specified stereochemistry in 3D."})";
  for (unsigned int i = 1; i <= molecule.NumAtoms(); ++i) {
    const auto* atom = molecule.GetAtom(i);
    if (!std::isfinite(atom->GetX()) || !std::isfinite(atom->GetY()) ||
        !std::isfinite(atom->GetZ()))
      return R"({"ok":false,"error":"Open Babel generated invalid coordinates."})";
  }
  molecule.SetDimension(3);
  const auto molfile = conversion.WriteString(&molecule);
  if (molfile.empty())
    return R"({"ok":false,"error":"Unable to export the generated molecule."})";
  return std::string(R"({"ok":true,"optimized":)") +
         (optimized ? "true" : "false") + R"(,"molfile":)" +
         jsonString(molfile) + "}";
}

std::string gasteigerCharges(const std::string& molfile)
{
  OpenBabel::OBConversion conversion;
  OpenBabel::OBMol molecule;
  if (!conversion.SetInFormat("mol") ||
      !conversion.ReadString(&molecule, molfile) || molecule.NumAtoms() == 0)
    return R"({"ok":false,"error":"Unable to read a nonempty MOL molecule."})";
  auto* model = OpenBabel::OBChargeModel::FindType("gasteiger");
  if (!model)
    return R"({"ok":false,"error":"The Open Babel Gasteiger plugin is unavailable."})";
  if (!model->ComputeCharges(molecule))
    return R"({"ok":false,"error":"Open Babel could not assign Gasteiger charges to this molecule."})";
  const auto& charges = model->GetPartialCharges();
  if (charges.size() != molecule.NumAtoms())
    return R"({"ok":false,"error":"Open Babel returned an incorrect charge count."})";
  std::ostringstream result;
  result << std::setprecision(17)
         << R"({"ok":true,"model":"gasteiger","charges":[)";
  for (size_t i = 0; i < charges.size(); ++i) {
    if (!std::isfinite(charges[i]))
      return R"({"ok":false,"error":"Open Babel returned a nonfinite charge."})";
    if (i)
      result << ',';
    result << charges[i];
  }
  result << "]}";
  return result.str();
}

#ifdef __EMSCRIPTEN__
EMSCRIPTEN_BINDINGS(openbabel_web)
{
  emscripten::function("gasteigerCharges", &gasteigerCharges);
  emscripten::function("generate3DFromSmiles", &generate3DFromSmiles);
}
#else
int main(int argc, char** argv)
{
  const std::string input{ std::istreambuf_iterator<char>(std::cin),
                           std::istreambuf_iterator<char>() };
  const auto result = argc == 2 && std::string(argv[1]) == "--smiles"
                        ? generate3DFromSmiles(input)
                        : gasteigerCharges(input);
  std::cout << result << '\n';
  return result.find("\"ok\":true") == std::string::npos ? 1 : 0;
}
#endif
