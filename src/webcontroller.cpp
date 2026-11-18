// SPDX-License-Identifier: BSD-3-Clause
#include "webcontroller.h"

#include <QAction>
#include <QBuffer>
#include <QCoreApplication>
#include <QJsonArray>
#include <QMouseEvent>
#include <QUndoStack>
#include <QWheelEvent>
#include <algorithm>
#include <avogadro/core/atom.h>
#include <avogadro/core/basisset.h>
#include <avogadro/core/bond.h>
#include <avogadro/core/cube.h>
#include <avogadro/core/layermanager.h>
#include <avogadro/core/stereo.h>
#include <avogadro/core/unitcell.h>
#include <avogadro/io/fileformatmanager.h>
#include <avogadro/qtgui/extensionplugin.h>
#include <avogadro/qtgui/layermodel.h>
#include <avogadro/qtgui/molecule.h>
#include <avogadro/qtgui/rwmolecule.h>
#include <avogadro/qtgui/sceneplugin.h>
#include <avogadro/qtopengl/glwidget.h>
#include <avogadro/qtplugins/pluginmanager.h>
#include <cmath>
#include <sstream>
#include <stdexcept>
#include <utility>

namespace Avogadro::Web {
namespace {
QJsonObject failure(const QString& error)
{
  return { { "ok", false }, { "error", error } };
}
QString actionArgument(const QString& id)
{
  if (id == "atomProperties" || id == "bondProperties")
    return QStringLiteral("index");
  if (id == "editUnitCell")
    return QStringLiteral("vectors");
  if (id == "buildSupercell")
    return QStringLiteral("repeats");
  if (id == "selectElement")
    return QStringLiteral("element");
  if (id == "selectResidue")
    return QStringLiteral("residue");
  return {};
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
    if (id == "AutoOpt")
      continue;
    auto* tool = factory->createInstance(&m_view);
    m_tools.insert(toolAliases.value(id, id), tool);
    m_view.addTool(tool);
    connect(tool, &QtGui::ToolPlugin::requestActiveDisplayTypes, this,
            &WebController::enableDisplayStyles);
  }
  for (const auto& id : toolAliases) {
    if (!m_tools.contains(id))
      throw std::runtime_error("A required web editor tool is missing");
  }
  connect(m_tools["draw"], SIGNAL(drawOptionsChanged()), this,
          SIGNAL(stateChanged()));

  if (auto* labelTool = m_tools.value("LabelEditor"))
    connect(labelTool, SIGNAL(atomPickedChanged()), this, SIGNAL(stateChanged()));

  m_calculationTimeout.setSingleShot(true);
  m_calculationTimeout.setInterval(120000);
  connect(&m_calculationTimeout, &QTimer::timeout, this, [this]() {
    const auto id = m_activeCalculator;
    auto* extension = m_calculators.take(id);
    // Shut down the plugin's workers while their molecule is still alive.
    // A fresh instance cannot receive results from the expired command.
    extension->disconnect(this);
    extension->setMolecule(nullptr);
    delete extension;
    addCalculator(id);
    if (auto* replacement = m_calculators.value(id))
      replacement->setMolecule(m_molecule.get());
    finishCalculation(tr("The calculation did not finish in time."), true);
  });
  m_actionLabels.insert("center", tr("Center and align view to axes"));
  m_actionLabels.insert("editUnitCell", tr("Set unit cell vectors"));
  m_actionLabels.insert("buildSupercell", tr("Build supercell"));
  m_actionLabels.insert("atomProperties", tr("Inspect atom properties"));
  m_actionLabels.insert("bondProperties", tr("Inspect bond properties"));
  m_actionLabels.insert("wrapUnitCell", tr("Wrap atoms to unit cell"));
  m_actionLabels.insert("reduceCell", tr("Reduce unit cell (Niggli)"));
  for (const auto& id : { "Hydrogens", "Bonding", "Select" })
    addActionPlugin(id);
  for (const auto& id : { "Forcefield", "Surfaces" })
    addCalculator(id);

  if (m_calculators.contains("Forcefield")) {
    m_actionLabels.insert("energy", tr("Calculate energy"));
    m_actionLabels.insert("forces", tr("Calculate forces"));
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

void WebController::addActionPlugin(const QString& id)
{
  auto* factory = QtPlugins::PluginManager::instance()
                    ->pluginFactory<QtGui::ExtensionPluginFactory>(id);
  if (!factory)
    return;
  auto* extension = factory->createInstance(this);
  m_actionPlugins.insert(id, extension);
  // Only commands with a reviewed headless interface belong in the editor.
  static const QStringList commands{
    "adjustHydrogens", "removeHydrogens",   "removeAllHydrogens", "removeBonds",
    "createBonds",     "bondSelectedAtoms", "addBondOrders",      "selectAll",
    "selectNone",      "invertSelection",   "selectElement",      "selectWater",
    "selectResidue"
  };
  connect(extension, &QtGui::ExtensionPlugin::registerCommand, this,
          [this, id](const QString& name, const QString& description) {
            if (commands.contains(name)) {
              m_actionLabels.insert(name, description);
              m_actionOwners.insert(name, id);
            }
          });
  extension->registerCommands();
}

bool WebController::actionEnabled(const QString& id) const
{
  if (!m_actionLabels.contains(id) || m_calculating || !m_molecule->atomCount())
    return false;
  if (id == "bondProperties")
    return m_molecule->bondCount() > 0;
  if (id == "center" || id == "atomProperties" ||
      m_actionOwners.value(id) == "Select")
    return true;
  if ((id == "wrapUnitCell" || id == "reduceCell" || id == "buildSupercell") &&
      (!m_molecule->unitCell() || !m_molecule->unitCell()->isRegular()))
    return false;
  // Bulk edit extensions can touch neighbours outside the selection.
  for (size_t i = 0; i < m_layers->layerCount(); ++i)
    if (m_layers->layerLocked(i))
      return false;
  if (id == "bondSelectedAtoms") {
    int selected = 0;
    for (Index i = 0; i < m_molecule->atomCount(); ++i)
      if (m_molecule->atomSelected(i) && ++selected > 1)
        return true;
    return false;
  }
  return true;
}

QJsonObject WebController::runAction(const QString& id,
                                     const QJsonObject& options)
{
  if (!actionEnabled(id))
    return failure(tr("This action is unavailable for the current document."));
  const QString argument = actionArgument(id);
  if (options.keys() !=
      (argument.isEmpty() ? QStringList{} : QStringList{ argument }))
    return failure(tr("Invalid action options."));
  const auto value = options.value(argument);
  if (argument == "index")
    return properties(id, value);
  if (argument == "vectors" || argument == "repeats")
    return changeCell(id, value.toArray());
  if (!argument.isEmpty() &&
      (!value.isString() || value.toString().trimmed().isEmpty() ||
       value.toString().size() > 32))
    return failure(tr("Invalid action options."));
  if (id == "center")
    resetCamera();
  else if (id == "wrapUnitCell")
    m_molecule->undoMolecule()->wrapAtomsToCell();
  else if (id == "reduceCell")
    m_molecule->undoMolecule()->niggliReduceCell();
  else if (id == "energy" || id == "forces") {
    if (!calculate(id, {}))
      return failure(tr("The calculation was rejected."));
  } else {
    auto* plugin = m_actionPlugins.value(m_actionOwners.value(id));
    QString error;
    auto connection =
      connect(plugin, &QtGui::ExtensionPlugin::commandFailed, this,
              [&error](const QString& reason) { error = reason; });
    const bool handled = plugin->handleCommand(id, options.toVariantMap());
    disconnect(connection);
    if (!handled || !error.isEmpty())
      return failure(error.isEmpty() ? tr("The action was rejected.") : error);
  }
  emit stateChanged();
  return { { "ok", true } };
}

QJsonObject WebController::properties(const QString& id,
                                      const QJsonValue& value) const
{
  const int index = value.toInt(-1);
  if (!value.isDouble() || index < 0 || value.toDouble() != index)
    return failure(tr("Expected a non-negative integer index."));
  QJsonObject properties{ { "index", index } };
  if (id == "atomProperties") {
    if (static_cast<Index>(index) >= m_molecule->atomCount())
      return failure(tr("Atom index out of range."));
    const auto atom = m_molecule->atom(index);
    const auto pos = atom.position3d();
    properties.insert("atomicNumber", atom.atomicNumber());
    properties.insert("formalCharge", atom.formalCharge());
    if (static_cast<Index>(index) < m_molecule->atomPositions3d().size())
      properties.insert("positionAngstrom",
                        QJsonArray{ pos.x(), pos.y(), pos.z() });
  } else {
    if (static_cast<Index>(index) >= m_molecule->bondCount())
      return failure(tr("Bond index out of range."));
    const auto bond = m_molecule->bond(index);
    properties.insert("begin", static_cast<int>(bond.atom1().index()));
    properties.insert("end", static_cast<int>(bond.atom2().index()));
    properties.insert("order", bond.order());
    if (bond.atom2().index() < m_molecule->atomPositions3d().size())
      properties.insert("lengthAngstrom", bond.length());
  }
  return { { "ok", true }, { "properties", properties } };
}

QJsonObject WebController::changeCell(const QString& id,
                                      const QJsonArray& values)
{
  auto* rw = m_molecule->undoMolecule();
  if (id == "editUnitCell") {
    if (values.size() != 9)
      return failure(tr("Enter three lattice vectors in ångströms."));
    Matrix3 matrix;
    for (int i = 0; i < 9; ++i) {
      const auto component = values[i];
      if (!component.isDouble() || !std::isfinite(component.toDouble()) ||
          std::abs(component.toDouble()) > 100000)
        return failure(tr("Invalid lattice vector component."));
      matrix(i % 3, i / 3) = component.toDouble();
    }
    if (!Core::UnitCell::isRegular(matrix) || matrix.determinant() < 1e-6)
      return failure(tr("Enter independent, right-handed lattice vectors."));
    const bool create = !m_molecule->unitCell();
    if (create) {
      rw->undoStack().beginMacro(tr("Add Unit Cell"));
      rw->addUnitCell();
    }
    rw->editUnitCell(matrix, Core::CrystalTools::None);
    if (create)
      rw->undoStack().endMacro();
  } else {
    const auto& positions = m_molecule->atomPositions3d();
    if (positions.size() != m_molecule->atomCount() ||
        !std::all_of(positions.begin(), positions.end(),
                     [](const Vector3& pos) { return pos.allFinite(); }))
      return failure(tr(
        "Supercell construction requires finite coordinates for each atom."));
    if (values.size() != 3)
      return failure(tr("Enter the number of copies along a, b and c."));
    int copies = 1;
    for (const auto& value : values) {
      const int n = value.toInt();
      if (!value.isDouble() || value.toDouble() != n || n < 1 || n > 32)
        return failure(tr("Supercell repeats must be integers from 1 to 32."));
      copies *= n;
    }
    if (copies == 1 || m_molecule->atomCount() > 100000u / copies ||
        m_molecule->bondCount() > 200000u / copies)
      return failure(tr("Choose a larger than 1×1×1 cell within 100,000 atoms "
                        "and 200,000 bonds."));
    rw->buildSupercell(values[0].toInt(), values[1].toInt(), values[2].toInt());
  }
  emit stateChanged();
  return { { "ok", true } };
}

void WebController::addCalculator(const QString& id)
{
  auto* factory = QtPlugins::PluginManager::instance()
                    ->pluginFactory<QtGui::ExtensionPluginFactory>(id);
  if (!factory)
    return;
  auto* extension = factory->createInstance(this);
  m_calculators.insert(id, extension);
  connect(extension, &QtGui::ExtensionPlugin::commandFinished, this,
          [this, id](QString message, const QVariantMap& result) {
            if (m_activeCalculator != id)
              return;
            if (result.contains("converged") &&
                !result.value("converged").toBool())
              message += tr(" (stopped: %1)").arg(result.value("reason").toString());
            finishCalculation(message, false);
          });
  connect(extension, &QtGui::ExtensionPlugin::commandFailed, this,
          [this, id](const QString& message) {
            if (m_activeCalculator == id)
              finishCalculation(message, true);
          });
  connect(extension, &QtGui::ExtensionPlugin::requestActiveDisplayTypes, this,
          &WebController::enableDisplayStyles);
}

void WebController::finishCalculation(const QString& message, bool error)
{
  m_calculationTimeout.stop();
  m_activeCalculator.clear();
  m_calculating = false;
  m_calculationMessage = message;
  m_calculationError = error;
  emit stateChanged();
}

WebController::~WebController()
{
  m_view.removeEventFilter(this);
  for (auto* extension : m_calculators) {
    extension->disconnect(this);
    extension->setMolecule(nullptr);
    delete extension;
  }
  for (auto* extension : m_actionPlugins)
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

void WebController::pan(double x, double y)
{
  if (m_calculating || !std::isfinite(x) || !std::isfinite(y))
    return;

  m_tools["navigate"]->handleCommand(
    "translateScene", { { "x", std::clamp(x, -1.0, 1.0) * m_view.width() },
                        { "y", std::clamp(y, -1.0, 1.0) * m_view.height() } });
}

QtGui::Molecule& WebController::molecule() const
{
  return *m_molecule;
}

QJsonObject WebController::captureViewport() const
{
  if (m_calculating)
    return failure(tr("Wait for the current calculation to finish."));
  auto image = m_view.grabFramebuffer();
  if (image.isNull())
    return failure(tr("The viewport image is unavailable."));
  if (image.width() > 1024 || image.height() > 1024)
    image =
      image.scaled(1024, 1024, Qt::KeepAspectRatio, Qt::SmoothTransformation);
  QBuffer buffer;
  buffer.open(QIODevice::WriteOnly);
  if (!image.save(&buffer, "PNG"))
    return failure(tr("Could not encode the viewport image."));
  return { { "ok", true },
           { "mimeType", "image/png" },
           { "width", image.width() },
           { "height", image.height() },
           { "data", QString::fromLatin1(buffer.data().toBase64()) } };
}

void WebController::touchPointer(const QString& phase, double x, double y,
                                 int modifiers)
{
  if (!std::isfinite(x) || !std::isfinite(y) || x < 0.0 || x > 1.0 || y < 0.0 ||
      y > 1.0 || modifiers < 0 || modifiers > 15)
    return;

  QEvent::Type type;
  if (phase == "press" && !m_touchPressed && !m_calculating) {
    m_touchPressed = true;
    type = QEvent::MouseButtonPress;
  } else if (phase == "move" && m_touchPressed && !m_calculating) {
    type = QEvent::MouseMove;
  } else if (phase == "release" && m_touchPressed) {
    m_touchPressed = false;
    type = QEvent::MouseButtonRelease;
  } else {
    return;
  }

  Qt::KeyboardModifiers keys;
  keys.setFlag(Qt::ShiftModifier, (modifiers & 1) != 0);
  keys.setFlag(Qt::ControlModifier, (modifiers & 2) != 0);
  keys.setFlag(Qt::AltModifier, (modifiers & 4) != 0);
  keys.setFlag(Qt::MetaModifier, (modifiers & 8) != 0);
  const QPointF position(x * m_view.width(), y * m_view.height());
  const auto button = type == QEvent::MouseMove ? Qt::NoButton : Qt::LeftButton;
  const auto buttons = m_touchPressed ? Qt::LeftButton : Qt::NoButton;
  QMouseEvent event(type, position, m_view.mapToGlobal(position), button,
                    buttons, keys);
  QCoreApplication::sendEvent(&m_view, &event);
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
  QJsonArray actions;
  for (auto it = m_actionLabels.cbegin(); it != m_actionLabels.cend(); ++it)
    actions.append(QJsonObject{
      { "id", it.key() },
      { "label", it.value() },
      { "enabled", actionEnabled(it.key()) },
      { "argument", actionArgument(it.key()) },
      { "calculation", it.key() == "energy" || it.key() == "forces" } });
  QJsonArray vectors;
  if (const auto* cell = m_molecule->unitCell()) {
    for (int col = 0; col < 3; ++col)
      for (int row = 0; row < 3; ++row)
        vectors.append(cell->cellMatrix()(row, col));
  }
  return {
    { "cellVectors", vectors },
    { "tool", m_tool },
    { "actions", actions },
    { "canOptimize", m_calculators.contains("Forcefield") },
    { "canRenderSurfaces", m_calculators.contains("Surfaces") },
    { "calculating", m_calculating },
    { "calculationMessage", m_calculationMessage },
    { "calculationError", m_calculationError },
    { "orbitalCount",
      basis ? static_cast<double>(basis->molecularOrbitalCount()) : 0.0 },
    { "homo", basis ? static_cast<double>(basis->homo()) : 0.0 },
    { "cubeCount", static_cast<double>(importedCubes) },
    { "pickedAtomIndex", pickedIndex },
    { "pickedLabel",
      labelTool ? labelTool->property("pickedLabel").toString() : QString() },
    { "tools", tools },
    { "displayStyles", styles },
    { "drawOptions", QJsonObject::fromVariantMap(
                       m_tools["draw"]->property("drawOptions").toMap()) },
    { "atomCount", static_cast<double>(m_molecule->atomCount()) },
    { "bondCount", static_cast<double>(m_molecule->bondCount()) },
    { "modified", !stack.isClean() },
    { "canUndo", stack.canUndo() },
    { "canRedo", stack.canRedo() }
  };
}

bool WebController::setTool(const QString& name)
{
  auto* tool = m_tools.value(name);
  if (!tool || m_calculating)
    return false;
  m_view.setActiveTool(tool);
  m_tool = name;
  emit stateChanged();
  return true;
}

void WebController::enableDisplayStyles(const QStringList& names)
{
  for (auto* style : m_view.sceneModel().scenePlugins()) {
    if (names.contains(style->name()) || names.contains(style->objectName()))
      setDisplayStyle(style->objectName(), true);
  }
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

bool WebController::calculate(const QString& command, const QVariantMap& options)
{
  const QStringList surfaceCommands{ "renderVDW", "renderSolventAccessible",
                                     "renderSolventExcluded", "renderOrbital",
                                     "renderElectronDensity", "renderCube" };
  if (m_calculating || m_molecule->atomCount() == 0 ||
      (!QStringList{ "optimize", "energy", "forces" }.contains(command) &&
       !surfaceCommands.contains(command)))
    return false;
  const QString id =
    surfaceCommands.contains(command) ? "Surfaces" : "Forcefield";
  auto* extension = m_calculators.value(id);
  if (!extension)
    return false;

  m_activeCalculator = id;
  m_calculating = true;
  m_calculationError = false;
  m_calculationMessage = tr("Calculating…");
  if (!extension->handleCommand(command, options)) {
    // A synchronous failure may already have supplied a more specific error.
    if (m_calculating)
      finishCalculation(tr("The calculation command was rejected."), true);
    return false;
  }
  if (m_calculating) {
    m_calculationTimeout.start();
    emit stateChanged();
  }
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
  for (auto* extension : m_actionPlugins)
    extension->setMolecule(m_molecule.get());
  m_calculationMessage.clear();
  const auto styles = m_view.sceneModel().scenePlugins();
  if (std::none_of(styles.begin(), styles.end(),
                   [](const auto* style) { return style->isEnabled(); })) {
    setDisplayStyle("BallStick", true);
    const auto& document = std::as_const(*m_molecule);
    if (document.unitCell())
      setDisplayStyle("CrystalScene", true);
    if (document.residueCount() > 0)
      setDisplayStyle("Cartoons", true);
  }
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
  if (!m_calculating)
    replaceMolecule(std::make_unique<QtGui::Molecule>());
}

QJsonObject WebController::loadMolecule(const QString& text,
                                        const QString& formatName)
{
  const QString format = formatName.toLower();
  if (m_calculating)
    return failure(tr("Wait for the current calculation to finish."));
  if (!supported(format) && format != "pdb" &&
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

QJsonObject WebController::insertFragment(const QString& sdf)
{
  if (m_calculating)
    return failure(tr("Wait for the current calculation to finish."));
  const auto info = Core::LayerManager::getMoleculeInfo(m_molecule.get());
  if (!info || m_layers->layerLocked(info->layer.activeLayer()))
    return failure(tr("The active layer is locked."));
  if (sdf.size() > 32 * 1024 * 1024)
    return failure(tr("The fragment exceeds the input limit."));
  bool multiple = false;
  const QString record = firstRecord(sdf, "sdf", multiple);
  if (multiple || !record.section('\n', 1, 1).trimmed().endsWith("3D"))
    return failure(tr("Insertion requires one 3D structure from PubChem."));
  try {
    QtGui::Molecule fragment;
    auto& formats = Io::FileFormatManager::instance();
    std::unique_ptr<Io::FileFormat> reader(
      formats.newFormatFromFileExtension("sdf", Io::FileFormat::Read));
    if (!reader || !reader->readString(record.toStdString(), fragment) ||
        !fragment.atomCount() ||
        fragment.atomPositions3d().size() != fragment.atomCount() ||
        !std::all_of(
          fragment.atomPositions3d().begin(), fragment.atomPositions3d().end(),
          [](const Vector3& position) { return position.allFinite(); }))
      return failure(tr("The returned 3D fragment could not be read."));
    // The SDF reader records total radical multiplicity but cannot assign
    // individual radical centers to the combined structure.
    if (fragment.hasData("totalSpinMultiplicity"))
      return failure(tr("Inserting radical fragments is unsupported."));
    const auto atomOffset = m_molecule->atomCount();
    const auto bondOffset = m_molecule->bondCount();
    QtGui::Molecule combined;
    combined = *m_molecule;
    combined.undoMolecule()->appendMolecule(fragment, tr("Insert fragment"));
    // appendMolecule copies positions, formal charges and bond orders.
    // Preserve isotope labels and explicitly unknown stereo on the snapshot.
    for (Index i = 0; i < fragment.atomCount(); ++i) {
      if (const auto isotope = fragment.isotope(i))
        combined.setIsotope(atomOffset + i, isotope);
      if (Core::atomStereoUnspecified(fragment, i))
        Core::setAtomStereoUnspecified(combined, atomOffset + i);
    }
    for (Index i = 0; i < fragment.bondCount(); ++i)
      if (Core::bondStereoUnspecified(fragment, i))
        Core::setBondStereoUnspecified(combined, bondOffset + i);
    if (combined.hasData("totalCharge"))
      combined.setData("totalCharge",
                       m_molecule->data("totalCharge").toInt() +
                         static_cast<int>(fragment.totalCharge()));
    using Molecule = QtGui::Molecule;
    m_molecule->undoMolecule()->modifyMolecule(
      combined,
      Molecule::Atoms | Molecule::Bonds | Molecule::Added | Molecule::Selection,
      tr("Insert fragment"));
    return { { "ok", true } };
  } catch (const std::exception& error) {
    return failure(QString::fromUtf8(error.what()));
  }
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
  if (m_calculating)
    return;
  m_molecule->undoMolecule()->undoStack().undo();
  m_view.updateScene();
}
void WebController::redo()
{
  if (m_calculating)
    return;
  m_molecule->undoMolecule()->undoStack().redo();
  m_view.updateScene();
}
bool WebController::setTheme(const QString& theme)
{
  if (theme != "dark" && theme != "light")
    return false;
  const Vector4ub color = theme == "dark" ? Vector4ub(16, 20, 26, 255)
                                         : Vector4ub(238, 241, 245, 255);
  m_view.renderer().scene().setBackgroundColor(color);
  m_view.update();
  return true;
}

void WebController::resetCamera()
{
  m_view.resetCamera();
  m_view.requestUpdate();
}

void WebController::deleteSelection()
{
  if (m_calculating)
    return;
  // The Editor command checks active, selected and neighbouring layer locks
  // before making a single undoable edit.
  m_tools["draw"]->handleCommand("removeSelectedAtoms", {});
}
} // namespace Avogadro::Web
