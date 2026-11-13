// SPDX-License-Identifier: BSD-3-Clause
#include "webcontroller.h"

#include <QAction>
#include <QJsonArray>
#include <QUndoStack>
#include <QWheelEvent>
#include <algorithm>
#include <avogadro/core/atom.h>
#include <avogadro/core/basisset.h>
#include <avogadro/core/cube.h>
#include <avogadro/qtgui/extensionplugin.h>
#include <avogadro/io/fileformatmanager.h>
#include <avogadro/qtgui/layermodel.h>
#include <avogadro/qtgui/molecule.h>
#include <avogadro/qtgui/rwmolecule.h>
#include <avogadro/qtgui/sceneplugin.h>
#include <avogadro/qtopengl/glwidget.h>
#include <avogadro/qtplugins/pluginmanager.h>
#include <sstream>
#include <stdexcept>

namespace Avogadro::Web {
namespace {
QJsonObject failure(const QString& error)
{
  return { { "ok", false }, { "error", error } };
}
bool supported(const QString& format)
{
  return QStringList{ "cjson", "mol", "sdf", "xyz" }.contains(format);
}
// XYZ's native reader also reads trajectory frames. Limit its input to the
// first record, without changing the reader's chemistry or perception rules.
QString firstRecord(const QString& text, const QString& format, bool& multiple)
{
  if (format == "sdf" || format == "mol") {
    const auto lines = text.split('\n');
    for (int i = 0; i < lines.size(); ++i) {
      if (lines[i].trimmed() == "$$$$") {
        multiple = !lines.mid(i + 1).join('\n').trimmed().isEmpty();
        return lines.mid(0, i + 1).join('\n') + '\n';
      }
    }
  } else if (format == "xyz") {
    const auto lines = text.split('\n');
    bool ok = false;
    const auto count = lines.first().trimmed().toULongLong(&ok);
    if (ok && count <= static_cast<qulonglong>(lines.size()) &&
        count + 2 <= static_cast<qulonglong>(lines.size())) {
      const auto end = static_cast<int>(count + 2);
      multiple = !lines.mid(end).join('\n').trimmed().isEmpty();
      return lines.mid(0, end).join('\n') + '\n';
    }
  }
  return text;
}
}

WebController::WebController(QtOpenGL::GLWidget& view, QObject* parent)
  : QObject(parent)
  , m_view(view)
  , m_layers(std::make_unique<QtGui::LayerModel>())
{
  auto* plugins = QtPlugins::PluginManager::instance();
  plugins->load();
  const QMap<QString, QString> toolAliases{ { "Navigator", "navigate" },
                                            { "Editor", "draw" },
                                            { "Selection", "select" } };
  for (auto* factory : plugins->pluginFactories<QtGui::ToolPluginFactory>()) {
    const auto id = factory->identifier();
    auto* tool = factory->createInstance(&m_view);
    m_tools.insert(toolAliases.value(id, id), tool);
    m_view.addTool(tool);
    connect(tool, &QtGui::ToolPlugin::requestActiveDisplayTypes, this,
            [this](const QStringList& names) {
              for (auto* style : m_view.sceneModel().scenePlugins()) {
                if (names.contains(style->name()) ||
                    names.contains(style->objectName()))
                  setDisplayStyle(style->objectName(), true);
              }
            });
  }
  for (const auto& id : toolAliases) {
    if (!m_tools.contains(id))
      throw std::runtime_error("A required web editor tool is missing");
  }
  connect(m_tools["draw"], SIGNAL(drawOptionsChanged()), this,
          SIGNAL(stateChanged()));

  if (auto* labelTool = m_tools.value("LabelEditor"))
    connect(labelTool, SIGNAL(atomPickedChanged()), this, SIGNAL(stateChanged()));

  if (auto* autoOpt = m_tools.value("AutoOpt"))
    connect(autoOpt, SIGNAL(runningChanged()), this, SIGNAL(stateChanged()));

  for (const auto& id : { "Forcefield", "Surfaces" }) {
    auto* factory = plugins->pluginFactory<QtGui::ExtensionPluginFactory>(id);
    if (!factory)
      continue;
    auto* extension = factory->createInstance(this);
    m_calculators.insert(id, extension);
    connect(extension, &QtGui::ExtensionPlugin::commandFinished, this,
            [this](const QString& message, const QVariantMap& result) {
              m_calculating = false;
              m_calculationMessage = message;
              if (result.contains("converged") &&
                  !result.value("converged").toBool())
                m_calculationMessage +=
                  tr(" (stopped: %1)").arg(result.value("reason").toString());
              m_calculationError = false;
              emit stateChanged();
            });
    connect(extension, &QtGui::ExtensionPlugin::commandFailed, this,
            [this](const QString& message) {
              m_calculating = false;
              m_calculationMessage = message;
              m_calculationError = true;
              emit stateChanged();
            });
    connect(extension, &QtGui::ExtensionPlugin::requestActiveDisplayTypes, this,
            [this](const QStringList&) {
              setDisplayStyle("SurfaceRender", true);
            });
  }

  auto& scene = m_view.sceneModel();
  for (auto* factory : plugins->pluginFactories<QtGui::ScenePluginFactory>())
    scene.addItem(factory->createInstance(&scene));
  connect(&scene, &QtGui::ScenePluginModel::pluginStateChanged, this,
          &WebController::stateChanged);
  m_view.setDefaultTool(m_tools["navigate"]);
  newMolecule();
  setTool("draw");
  m_view.installEventFilter(this);
}

WebController::~WebController()
{
  m_view.removeEventFilter(this);
  for (auto* extension : m_calculators)
    extension->setMolecule(nullptr);
  m_view.setMolecule(nullptr);
}

bool WebController::eventFilter(QObject* watched, QEvent* event)
{
  if (watched != &m_view || event->type() != QEvent::Wheel)
    return QObject::eventFilter(watched, event);

  const auto* wheel = static_cast<QWheelEvent*>(event);
  // Browser wheel input can contain hundreds of pixels per event. The
  // desktop Navigator treats each pixel as a zoom unit (2% of distance).
  // Keep fractional trackpad motion, use a gentle 2% per wheel notch, and
  // limit accelerated events to 5% so one scroll cannot lose the molecule.
  const float delta = wheel->pixelDelta().isNull()
                        ? wheel->angleDelta().y() / 120.0f
                        : wheel->pixelDelta().y() / 120.0f;
  if (delta != 0.0f)
    m_tools["navigate"]->handleCommand(
      "zoomScene", { { "delta", -std::clamp(delta, -2.5f, 2.5f) } });
  event->accept();
  return true;
}

void WebController::zoom(double delta)
{
  m_tools["navigate"]->handleCommand(
    "zoomScene", { { "delta", std::clamp(delta, -0.5, 0.5) } });
}

QtGui::Molecule& WebController::molecule() const
{
  return *m_molecule;
}

QJsonObject WebController::state() const
{
  const auto& stack = m_molecule->undoMolecule()->undoStack();
  QJsonArray tools;
  for (auto it = m_tools.cbegin(); it != m_tools.cend(); ++it) {
    const auto* action = it.value()->activateAction();
    tools.append(QJsonObject{ { "id", it.key() },
                              { "label", action ? action->text()
                                                : it.value()->name() } });
  }
  QJsonArray styles;
  for (auto* style : m_view.sceneModel().scenePlugins()) {
    styles.append(QJsonObject{ { "id", style->objectName() },
                               { "label", style->name() },
                               { "enabled", style->isActiveLayerEnabled() } });
  }
  const auto* labelTool = m_tools.value("LabelEditor");
  const auto pickedIndex =
    labelTool ? labelTool->property("pickedAtomIndex").toLongLong() : -1;
  const auto* basis = m_molecule->basisSet();
  const auto cubes = m_molecule->cubes();
  const auto importedCubes = std::count_if(
    cubes.begin(), cubes.end(), [](const Core::Cube* cube) {
      return cube && cube->cubeType() == Core::Cube::Type::FromFile;
    });
  return { { "tool", m_tool },
           { "canOptimize", m_calculators.contains("Forcefield") },
           { "canRenderSurfaces", m_calculators.contains("Surfaces") },
           { "calculating", m_calculating },
           { "autoOptimizing", autoOptimizing() },
           { "calculationMessage", m_calculationMessage },
           { "calculationError", m_calculationError },
           { "orbitalCount", basis ? static_cast<double>(basis->molecularOrbitalCount()) : 0.0 },
           { "homo", basis ? static_cast<double>(basis->homo()) : 0.0 },
           { "cubeCount", static_cast<double>(importedCubes) },
           { "pickedAtomIndex", pickedIndex },
           { "pickedLabel", labelTool ? labelTool->property("pickedLabel").toString()
                                       : QString() },
           { "tools", tools },
           { "displayStyles", styles },
           { "drawOptions",
             QJsonObject::fromVariantMap(
               m_tools["draw"]->property("drawOptions").toMap()) },
           { "atomCount", static_cast<double>(m_molecule->atomCount()) },
           { "bondCount", static_cast<double>(m_molecule->bondCount()) },
           { "modified", !stack.isClean() },
           { "canUndo", stack.canUndo() },
           { "canRedo", stack.canRedo() } };
}

bool WebController::setTool(const QString& name)
{
  auto* tool = m_tools.value(name);
  if (!tool || m_calculating || autoOptimizing())
    return false;
  m_view.setActiveTool(tool);
  m_tool = name;
  emit stateChanged();
  return true;
}

bool WebController::setDisplayStyle(const QString& id, bool enabled)
{
  auto& model = m_view.sceneModel();
  for (int row = 0; row < model.rowCount({}); ++row) {
    if (model.scenePlugin(row)->objectName() == id)
      return model.setData(model.index(row, 0),
                           enabled ? Qt::Checked : Qt::Unchecked,
                           Qt::CheckStateRole);
  }
  return false;
}

bool WebController::alignPickedAtoms(const QString& axis)
{
  auto* tool = m_tools.value("AlignTool");
  return m_tool == "AlignTool" && tool &&
         tool->handleCommand("alignPickedAtoms", { { "axis", axis } });
}

bool WebController::setPickedLabel(const QString& label)
{
  auto* tool = m_tools.value("LabelEditor");
  return m_tool == "LabelEditor" && tool &&
         tool->handleCommand("setPickedLabel", { { "label", label } });
}

bool WebController::autoOptimizing() const
{
  const auto* tool = m_tools.value("AutoOpt");
  return tool && tool->property("running").toBool();
}

bool WebController::setAutoOptimize(bool enabled, const QString& method)
{
  auto* tool = m_tools.value("AutoOpt");
  if (m_calculating || m_tool != "AutoOpt" || !tool)
    return false;
  return tool->handleCommand(enabled ? "startAutoOptimize" : "stopAutoOptimize",
                             { { "method", method } });
}

bool WebController::calculate(const QString& command, const QVariantMap& options)
{
  const QStringList surfaceCommands{ "renderVDW", "renderSolventAccessible",
                                     "renderSolventExcluded", "renderOrbital",
                                     "renderElectronDensity", "renderCube" };
  if (m_calculating || autoOptimizing() || m_molecule->atomCount() == 0 ||
      (command != "optimize" && !surfaceCommands.contains(command)))
    return false;
  auto* extension = m_calculators.value(command == "optimize" ? "Forcefield"
                                                               : "Surfaces");
  if (!extension)
    return false;

  m_calculating = true;
  m_calculationError = false;
  m_calculationMessage = tr("Calculating…");
  if (!extension->handleCommand(command, options)) {
    m_calculating = false;
    return false;
  }
  emit stateChanged();
  return true;
}

bool WebController::setDrawOptions(const QVariantMap& options)
{
  return m_tools["draw"]->handleCommand("setDrawOptions", options);
}

void WebController::replaceMolecule(std::unique_ptr<QtGui::Molecule> next)
{
  // QtGui::Molecule must be default-constructed before reading: that
  // constructor initializes its undo wrapper and stable atom/bond identifiers.
  auto previous = std::move(m_molecule);
  m_molecule = std::move(next);
  m_layers->addMolecule(m_molecule.get());
  m_view.setMolecule(m_molecule.get());
  for (auto* extension : m_calculators)
    extension->setMolecule(m_molecule.get());
  m_calculationMessage.clear();
  if (m_molecule->layerInfo()->enable.empty())
    setDisplayStyle("BallStick", true);
  auto& stack = m_molecule->undoMolecule()->undoStack();
  stack.clear();
  stack.setClean();
  connect(&stack, &QUndoStack::indexChanged, this,
          &WebController::stateChanged);
  connect(&stack, &QUndoStack::cleanChanged, this,
          &WebController::stateChanged);
  connect(m_molecule.get(), &QtGui::Molecule::changed, this,
          &WebController::stateChanged);
  m_view.updateScene();
  resetCamera();
  emit stateChanged();
}

void WebController::newMolecule()
{
  if (!m_calculating && !autoOptimizing())
    replaceMolecule(std::make_unique<QtGui::Molecule>());
}

QJsonObject WebController::loadMolecule(const QString& text,
                                        const QString& formatName)
{
  const QString format = formatName.toLower();
  if (m_calculating || autoOptimizing())
    return failure(tr("Wait for the current calculation to finish."));
  if (!supported(format) &&
      !(m_calculators.contains("Surfaces") &&
        QStringList{ "fchk", "molden", "cube" }.contains(format)))
    return failure(tr("Unsupported molecule file format."));
  bool multiple = false;
  const auto input = firstRecord(text, format, multiple).toStdString();
  auto next = std::make_unique<QtGui::Molecule>();
  auto& formats = Io::FileFormatManager::instance();
  std::unique_ptr<Io::FileFormat> reader(formats.newFormatFromFileExtension(
    format.toStdString(), Io::FileFormat::Read));
  try {
    if (!reader || !reader->readString(input, *next))
      return failure(reader ? QString::fromStdString(reader->error())
                            : "Reader unavailable.");
  } catch (const std::exception& error) {
    return failure(QString::fromUtf8(error.what()));
  }
  replaceMolecule(std::move(next));
  return { { "ok", true },
           { "notice",
             multiple ? "Only the first molecule/frame was imported." : "" } };
}

QJsonObject WebController::exportMolecule(const QString& formatName) const
{
  const QString format = formatName.toLower();
  if (!supported(format))
    return failure("Supported formats: CJSON, MOL, SDF, XYZ.");
  auto& formats = Io::FileFormatManager::instance();
  std::unique_ptr<Io::FileFormat> writer(formats.newFormatFromFileExtension(
    format.toStdString(), Io::FileFormat::Write));
  std::string text;
  try {
    if (!writer || !writer->writeString(text, *m_molecule))
      return failure(writer ? QString::fromStdString(writer->error())
                            : "Writer unavailable.");
  } catch (const std::exception& error) {
    return failure(QString::fromUtf8(error.what()));
  }
  return { { "ok", true }, { "text", QString::fromStdString(text) } };
}

void WebController::markSaved()
{
  m_molecule->undoMolecule()->undoStack().setClean();
}
void WebController::undo()
{
  if (m_calculating || autoOptimizing())
    return;
  m_molecule->undoMolecule()->undoStack().undo();
  m_view.updateScene();
}
void WebController::redo()
{
  if (m_calculating || autoOptimizing())
    return;
  m_molecule->undoMolecule()->undoStack().redo();
  m_view.updateScene();
}
void WebController::resetCamera()
{
  m_view.resetCamera();
  m_view.requestUpdate();
}

void WebController::deleteSelection()
{
  if (m_calculating || autoOptimizing())
    return;
  // The Editor command checks active, selected and neighbouring layer locks
  // before making a single undoable edit.
  m_tools["draw"]->handleCommand("removeSelectedAtoms", {});
}
} // namespace Avogadro::Web
