// SPDX-License-Identifier: BSD-3-Clause
#include "webcontroller.h"
#include <QApplication>
#include <QCheckBox>
#include <QComboBox>
#include <QJsonArray>
#include <QMouseEvent>
#include <QSignalSpy>
#include <QUndoStack>
#include <QWheelEvent>
#include <avogadro/core/atom.h>
#include <avogadro/core/bond.h>
#include <avogadro/core/layermanager.h>
#include <avogadro/core/stereo.h>
#include <avogadro/qtgui/molecule.h>
#include <avogadro/qtgui/rwmolecule.h>
#include <avogadro/qtopengl/glwidget.h>
#include <avogadro/qtplugins/pluginmanager.h>
#include <gtest/gtest.h>
#include <limits>
#include <vector>

using namespace Avogadro;
class WebEditorTest : public testing::Test
{
protected:
  QtOpenGL::GLWidget view;
  Web::WebController editor{ view };
  QtGui::ToolPlugin* draw()
  {
    editor.setTool("draw");
    return view.activeTool();
  }
  void clickAtom()
  {
    // Configure the CPU camera directly: this test intentionally has no GL
    // context.
    view.renderer().camera().setViewport(640, 480);
    view.renderer().camera().calculatePerspective(40.0f, 0.1f, 100.0f);
    auto* tool = draw();
    QMouseEvent press(QEvent::MouseButtonPress, QPointF(320, 240),
                      QPointF(320, 240), Qt::LeftButton, Qt::LeftButton,
                      Qt::NoModifier);
    QMouseEvent release(QEvent::MouseButtonRelease, QPointF(320, 240),
                        QPointF(320, 240), Qt::LeftButton, Qt::NoButton,
                        Qt::NoModifier);
    tool->mousePressEvent(&press);
    tool->mouseReleaseEvent(&release);
  }
};

TEST_F(WebEditorTest, DispatchesOnlyEnabledActionsWithValidOptions)
{
  const auto run = [this](const QString& id, const QJsonObject& options = {}) {
    return editor.runAction(id, options).value("ok").toBool();
  };
  EXPECT_FALSE(run("center"));
  ASSERT_TRUE(
    editor.loadMolecule("1\ncarbon\nC 0 0 0\n", "xyz").value("ok").toBool());
  EXPECT_TRUE(run("center"));
  EXPECT_FALSE(run("center", { { "ignored", true } }));
  EXPECT_FALSE(run("missing"));
  EXPECT_FALSE(run("wrapUnitCell"));
  EXPECT_FALSE(run("bondSelectedAtoms"));
  EXPECT_FALSE(editor.state().value("modified").toBool());
  if (editor.state().value("canOptimize").toBool()) {
    ASSERT_TRUE(run("energy"));
    EXPECT_FALSE(run("center"));
    EXPECT_FALSE(run("forces"));
  }
}

TEST_F(WebEditorTest, Inserts3DFragmentAsOneChemicallyFaithfulEdit)
{
  ASSERT_TRUE(
    editor.loadMolecule("1\nHelium\nHe 3 2 1\n", "xyz")["ok"].toBool());
  const auto before = editor.exportMolecule("cjson").value("text").toString();
  const auto sdf = QStringLiteral(
    "Fragment\n  fixture             3D\n\n"
    "  2  1  0  0  0  0  0  0  0  0999 V2000\n"
    "    0.0000    0.0000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0\n"
    "    1.2000    0.0000    0.0000 O   0  0  0  0  0  0  0  0  0  0  0  0\n"
    "  1  2  2  3  0  0  0\nM  ISO  1   1  13\nM  CHG  1   1  -1\nM  "
    "END\n$$$$\n");
  EXPECT_FALSE(
    editor.insertFragment(QString(sdf).replace("3D", "2D"))["ok"].toBool());
  EXPECT_FALSE(editor.insertFragment(sdf + sdf)["ok"].toBool());
  EXPECT_FALSE(editor.insertFragment("unreadable")["ok"].toBool());
  EXPECT_FALSE(editor
                 .insertFragment(QString(sdf).replace(
                   "M  END", "M  RAD  1   1   2\nM  END"))["ok"]
                 .toBool());
  EXPECT_EQ(before, editor.exportMolecule("cjson").value("text").toString());
  const auto result = editor.insertFragment(sdf);
  ASSERT_TRUE(result["ok"].toBool())
    << result["error"].toString().toStdString();
  auto& mol = editor.molecule();
  ASSERT_EQ(mol.atomCount(), 3);
  EXPECT_EQ(mol.atom(0).atomicNumber(), 2);
  EXPECT_EQ(mol.atom(0).position3d(), Vector3(3, 2, 1));
  EXPECT_EQ(mol.atom(1).atomicNumber(), 6);
  EXPECT_EQ(mol.atom(1).isotope(), 13);
  EXPECT_EQ(mol.atom(1).formalCharge(), -1);
  EXPECT_EQ(mol.atom(2).atomicNumber(), 8);
  EXPECT_DOUBLE_EQ(mol.atom(2).position3d().x(), 1.2);
  ASSERT_EQ(mol.bondCount(), 1);
  EXPECT_EQ(mol.bond(1, 2).order(), 2);
  EXPECT_TRUE(Core::bondStereoUnspecified(mol, 0));
  const auto after = editor.exportMolecule("cjson").value("text").toString();
  editor.undo();
  EXPECT_EQ(before, editor.exportMolecule("cjson").value("text").toString());
  EXPECT_FALSE(editor.state()["modified"].toBool());
  editor.redo();
  EXPECT_EQ(after, editor.exportMolecule("cjson").value("text").toString());
  EXPECT_TRUE(Core::bondStereoUnspecified(mol, 0));
}

TEST_F(WebEditorTest, ReadsPropertiesAndEditsCrystalWithUndo)
{
  ASSERT_TRUE(
    editor
      .loadMolecule(
        R"({"chemicalJson":1,"atoms":{"elements":{"number":[1,1]},"coords":{"3d":[0,0,0,0,0,0.74]}},"bonds":{"connections":{"index":[0,1]},"order":[1]}})",
        "cjson")
      .value("ok")
      .toBool());
  const auto atom = editor.runAction("atomProperties", { { "index", 1 } });
  EXPECT_EQ(atom["properties"].toObject()["atomicNumber"], 1);
  const auto bond = editor.runAction("bondProperties", { { "index", 0 } });
  ASSERT_TRUE(bond["ok"].toBool());
  EXPECT_NEAR(bond["properties"].toObject()["lengthAngstrom"].toDouble(), 0.74,
              1e-6);
  EXPECT_FALSE(
    editor.runAction("atomProperties", { { "index", 2 } })["ok"].toBool());
  EXPECT_FALSE(
    editor.runAction("bondProperties", { { "index", 0.2 } })["ok"].toBool());
  EXPECT_FALSE(
    editor
      .runAction("editUnitCell", { { "vectors", QJsonArray{ 1, 0, 0, 1, 0, 0, 0,
                                                            0, 1 } } })["ok"]
      .toBool());
  EXPECT_FALSE(editor.molecule().unitCell());
  EXPECT_FALSE(editor.state()["modified"].toBool());
  const QJsonArray vectors{ 4, 0, 0, 0, 5, 0, 0, 0, 6 };
  ASSERT_TRUE(editor.runAction("editUnitCell", { { "vectors", vectors } })["ok"]
                .toBool());
  EXPECT_EQ(editor.state()["cellVectors"].toArray(), vectors);
  EXPECT_FALSE(editor
                 .runAction("buildSupercell",
                            { { "repeats", QJsonArray{ 33, 1, 1 } } })["ok"]
                 .toBool());
  EXPECT_FALSE(editor
                 .runAction("buildSupercell",
                            { { "repeats", QJsonArray{ 1.5, 1, 1 } } })["ok"]
                 .toBool());
  ASSERT_TRUE(editor
                .runAction("buildSupercell",
                           { { "repeats", QJsonArray{ 2, 1, 1 } } })["ok"]
                .toBool());
  EXPECT_EQ(editor.molecule().atomCount(), 4);
  EXPECT_EQ(editor.state()["cellVectors"].toArray()[0], 8);
  editor.undo();
  EXPECT_EQ(editor.molecule().atomCount(), 2);
  EXPECT_EQ(editor.state()["cellVectors"].toArray(), vectors);
  editor.undo();
  EXPECT_FALSE(editor.molecule().unitCell());
  EXPECT_FALSE(editor.state()["modified"].toBool());
}

TEST_F(WebEditorTest, CentersAndAlignsCameraWithoutEditingCoordinates)
{
  ASSERT_TRUE(
    editor.loadMolecule("1\nhelium\nHe 0 0 0\n", "xyz").value("ok").toBool());
  view.renderer().camera().rotate(0.8f, Vector3f::UnitY());
  ASSERT_TRUE(editor.runAction("center", {})["ok"].toBool());
  EXPECT_TRUE(view.renderer().camera().modelView().linear().isIdentity(1e-6));
  EXPECT_FALSE(editor.state()["modified"].toBool());
}

TEST_F(WebEditorTest, TouchPointerUsesLogicalViewportCoordinates)
{
  view.resize(640, 480);
  auto& camera = view.renderer().camera();
  camera.setViewport(view.width(), view.height());
  camera.calculatePerspective(40.0f, 0.1f, 100.0f);
  draw();
  ASSERT_TRUE(editor.setDrawOptions({ { "adjustHydrogens", false } }));

  editor.touchPointer("press", std::numeric_limits<double>::quiet_NaN(), 0.5,
                      0);
  editor.touchPointer("press", 0.25, 1.5, 0);
  editor.touchPointer("press", 0.25, 0.5, 16);
  editor.touchPointer("move", 0.25, 0.5, 0);
  EXPECT_EQ(editor.molecule().atomCount(), 0);

  editor.touchPointer("press", 0.25, 0.65, 0);
  editor.touchPointer("press", 0.75, 0.30, 0);
  editor.touchPointer("release", 0.25, 0.65, 0);
  ASSERT_EQ(editor.molecule().atomCount(), 1);
  EXPECT_EQ(editor.molecule().bondCount(), 0);
  const Vector3f point = editor.molecule().atom(0).position3d().cast<float>();
  const Vector3f projected = camera.project(point);
  EXPECT_NEAR(projected.x(), 160.0, 1e-3);
  EXPECT_NEAR(projected.y(), 168.0, 1e-3);

  editor.undo();
  EXPECT_EQ(editor.molecule().atomCount(), 0);
}

TEST_F(WebEditorTest, PanPreservesDocumentAndMovesFocusAtEachZoom)
{
  clickAtom();
  view.resize(640, 480);
  auto& camera = view.renderer().camera();
  camera.setViewport(view.width(), view.height());
  camera.calculatePerspective(40.0f, 0.1f, 100.0f);

  const auto initialState = editor.state();
  const auto initialMolecule = editor.exportMolecule("cjson");
  const auto projectFocus = [&]() { return camera.project(camera.focus()); };
  for (int zoom = 0; zoom < 2; ++zoom) {
    const auto before = projectFocus();
    const auto orientation = camera.modelView().linear().eval();
    editor.pan(0.125, -0.1);
    const auto after = projectFocus();
    EXPECT_NEAR(after.x() - before.x(), 80.0, 1e-2);
    EXPECT_NEAR(after.y() - before.y(), 48.0, 1e-2);
    EXPECT_NEAR(after.z(), before.z(), 1e-5);
    EXPECT_TRUE(camera.modelView().linear().isApprox(orientation));
    editor.pan(std::numeric_limits<double>::infinity(), 0.1);
    EXPECT_TRUE(projectFocus().isApprox(after));
    for (int step = 0; step < 30; ++step)
      editor.zoom(0.5);
  }
  EXPECT_EQ(editor.state(), initialState);
  EXPECT_EQ(editor.exportMolecule("cjson"), initialMolecule);
  editor.undo();
  EXPECT_EQ(editor.molecule().atomCount(), 0);
}

TEST_F(WebEditorTest, OpenRestoresAvailableStylesOrFallsBackToBallAndStick)
{
  const auto enabled = [this](const QString& id) {
    const auto styles = editor.state().value("displayStyles").toArray();
    for (const auto& value : styles) {
      const auto style = value.toObject();
      if (style.value("id") == id)
        return style.value("enabled").toBool();
    }
    return false;
  };
  ASSERT_TRUE(editor.loadMolecule("1\ncarbon\nC 0 0 0\n", "xyz")
                .value("ok").toBool());
  ASSERT_TRUE(enabled("BallStick"));
  ASSERT_TRUE(editor.setDisplayStyle("BallStick", false));
  ASSERT_TRUE(editor.setDisplayStyle("Wireframe", true));
  auto saved = editor.exportMolecule("cjson").value("text").toString();
  ASSERT_TRUE(editor.loadMolecule(saved, "cjson").value("ok").toBool());
  EXPECT_TRUE(enabled("Wireframe"));
  EXPECT_FALSE(enabled("BallStick"));

  auto& styles = editor.molecule().layerInfo()->enable;
  styles.clear();
  styles.emplace("UnavailableStyle", std::vector<bool>{ true });
  saved = editor.exportMolecule("cjson").value("text").toString();
  ASSERT_TRUE(editor.loadMolecule(saved, "cjson").value("ok").toBool());
  EXPECT_TRUE(enabled("BallStick"));
  EXPECT_FALSE(enabled("Wireframe"));
}

TEST_F(WebEditorTest, ThemeChangesPreserveDocumentAndHistory)
{
  clickAtom();
  const auto before = editor.state();
  const auto molecule = editor.exportMolecule("cjson");
  ASSERT_TRUE(editor.setTheme("light"));
  EXPECT_EQ(view.renderer().scene().backgroundColor()[0], 238);
  EXPECT_EQ(editor.state(), before);
  EXPECT_EQ(editor.exportMolecule("cjson"), molecule);
  ASSERT_TRUE(editor.setTheme("dark"));
  EXPECT_EQ(view.renderer().scene().backgroundColor()[0], 16);
  EXPECT_FALSE(editor.setTheme("invalid"));
  EXPECT_EQ(view.renderer().scene().backgroundColor()[0], 16);
  EXPECT_EQ(editor.state(), before);
  editor.undo();
  EXPECT_EQ(editor.molecule().atomCount(), 0);
}

TEST_F(WebEditorTest, WheelZoomIsGentleAndBoundedInEveryTool)
{
  auto& camera = view.renderer().camera();
  const auto distance = [&]() {
    return (camera.modelView() * camera.focus()).norm();
  };
  const auto scroll = [&](QPoint pixels, QPoint angle) {
    QWheelEvent event(QPointF(320, 240), QPointF(320, 240), pixels,
                      angle, Qt::NoButton, Qt::NoModifier,
                      Qt::NoScrollPhase, false);
    QApplication::sendEvent(&view, &event);
    EXPECT_TRUE(event.isAccepted());
  };
  for (const auto* tool : { "draw", "navigate", "select" }) {
    ASSERT_TRUE(editor.setTool(tool));
    editor.resetCamera();
    const float initial = distance();
    ASSERT_GT(initial, 3.0f);
    scroll({}, QPoint(0, 120));
    EXPECT_NEAR(distance() / initial, 1.02f, 0.0001f);

    const float beforePixel = distance();
    scroll(QPoint(0, -120), QPoint(0, -120));
    EXPECT_NEAR(distance() / beforePixel, 0.98f, 0.0001f);

    const float beforeTiny = distance();
    scroll(QPoint(0, 1), {});
    EXPECT_GT(distance(), beforeTiny);
    EXPECT_LT(distance() / beforeTiny, 1.001f);

    const float beforeLarge = distance();
    scroll(QPoint(0, 10000), {});
    EXPECT_NEAR(distance() / beforeLarge, 1.05f, 0.0001f);
    const float beforeReverse = distance();
    scroll(QPoint(0, -10000), {});
    EXPECT_NEAR(distance() / beforeReverse, 0.95f, 0.0001f);

    const float beforeHorizontal = distance();
    scroll(QPoint(120, 0), QPoint(0, 120));
    EXPECT_FLOAT_EQ(distance(), beforeHorizontal);
    scroll({}, {});
    EXPECT_FLOAT_EQ(distance(), beforeHorizontal);
  }
}

TEST_F(WebEditorTest, DefaultsAndWidgetIndependentOptions)
{
  auto* tool = draw();
  EXPECT_EQ(editor.state()["tool"].toString(), "draw");
  EXPECT_EQ(tool->property("drawOptions").toMap()["atomicNumber"].toInt(), 6);
  for (auto* widget : QApplication::allWidgets())
    EXPECT_STRNE(widget->metaObject()->className(),
                 "Avogadro::QtPlugins::EditorToolWidget");
  QSignalSpy changes(&editor, &Web::WebController::stateChanged);
  EXPECT_TRUE(editor.setDrawOptions({ { "atomicNumber", 8 },
                                      { "bondOrder", 2 },
                                      { "adjustHydrogens", false } }));
  EXPECT_FALSE(
    editor.setDrawOptions({ { "atomicNumber", 119 }, { "bondOrder", 1 } }));
  EXPECT_EQ(tool->property("drawOptions").toMap()["bondOrder"].toInt(), 2);
  EXPECT_FALSE(changes.isEmpty());
  EXPECT_FALSE(editor.setTool("unknown"));
  EXPECT_EQ(QtPlugins::PluginManager::instance()
              ->pluginFactory<QtGui::ToolPluginFactory>("missing-tool"),
            nullptr);
  EXPECT_EQ(editor.state()["tool"].toString(), "draw");
  auto* panel = tool->toolWidget();
  EXPECT_EQ(panel->findChild<QComboBox*>("bondOrder")->currentIndex(), 2);
  EXPECT_FALSE(panel->findChild<QCheckBox*>("adjustHydrogens")->isChecked());
  panel->findChild<QComboBox*>("bondOrder")->setCurrentIndex(3);
  EXPECT_EQ(tool->property("drawOptions").toMap()["bondOrder"].toInt(), 3);
  EXPECT_TRUE(editor.setDrawOptions({ { "bondOrder", 1 } }));
  EXPECT_EQ(panel->findChild<QComboBox*>("bondOrder")->currentIndex(), 1);
  delete panel; // The desktop may destroy the panel before the tool.
  EXPECT_EQ(
    tool->toolWidget()->findChild<QComboBox*>("bondOrder")->currentIndex(), 1);
}

TEST_F(WebEditorTest, DrawingHydrogensAndGroupedUndo)
{
  clickAtom();
  EXPECT_EQ(editor.molecule().atomCount(), 5); // existing carbon + H adjustment
  EXPECT_EQ(editor.molecule().bondCount(), 4);
  EXPECT_TRUE(editor.state()["modified"].toBool());
  editor.undo();
  EXPECT_EQ(editor.molecule().atomCount(), 0);
  EXPECT_FALSE(editor.state()["modified"].toBool());
  editor.redo();
  EXPECT_EQ(editor.molecule().atomCount(), 5);
  editor.newMolecule();
  editor.setDrawOptions(
    { { "atomicNumber", 8 }, { "adjustHydrogens", false } });
  clickAtom();
  EXPECT_EQ(editor.molecule().atomCount(), 1);
  EXPECT_EQ(editor.molecule().atom(0).atomicNumber(), 8);
}

TEST_F(WebEditorTest, RoundTripsAndFirstRecord)
{
  ASSERT_TRUE(
    editor.loadMolecule("2\nHydrogen\nH 0 0 0\nH 0 0 0.74\n", "xyz")["ok"]
      .toBool());
  for (const QString format : { "cjson", "mol", "sdf", "xyz" }) {
    auto result = editor.exportMolecule(format);
    ASSERT_TRUE(result["ok"].toBool())
      << result["error"].toString().toStdString();
    auto loaded = editor.loadMolecule(result["text"].toString(), format);
    ASSERT_TRUE(loaded["ok"].toBool())
      << loaded["error"].toString().toStdString();
    EXPECT_EQ(editor.molecule().atomCount(), 2);
    EXPECT_NEAR(editor.molecule().atom(1).position3d().z(), .74, .0001);
  }
  const auto sdf = editor.exportMolecule("sdf")["text"].toString();
  auto result = editor.loadMolecule(sdf + sdf, "sdf");
  EXPECT_TRUE(result["ok"].toBool());
  EXPECT_FALSE(result["notice"].toString().isEmpty());
  EXPECT_FALSE(
    editor.loadMolecule(sdf + sdf, "mol")["notice"].toString().isEmpty());
  result =
    editor.loadMolecule("1\nfirst\nO 0 0 0\n1\nsecond\nN 1 1 1\n", "xyz");
  ASSERT_TRUE(result["ok"].toBool());
  EXPECT_FALSE(result["notice"].toString().isEmpty());
  EXPECT_EQ(editor.molecule().atomCount(), 1);
  EXPECT_EQ(editor.molecule().atom(0).atomicNumber(), 8);
}

TEST_F(WebEditorTest, BondOrdersHydrogensAndUndoGrouping)
{
  for (int order : { 1, 2, 3 }) {
    editor.newMolecule();
    ASSERT_TRUE(editor.setDrawOptions({ { "atomicNumber", 6 },
                                        { "bondOrder", order },
                                        { "adjustHydrogens", true } }));
    // Configure the CPU camera directly: this test intentionally has no GL
    // context.
    view.renderer().camera().setViewport(640, 480);
    view.renderer().camera().calculatePerspective(40.0f, 0.1f, 100.0f);
    auto* tool = draw();
    QMouseEvent press(QEvent::MouseButtonPress, QPointF(320, 240),
                      QPointF(320, 240), Qt::LeftButton, Qt::LeftButton,
                      Qt::NoModifier);
    QMouseEvent move(QEvent::MouseMove, QPointF(400, 240), QPointF(400, 240),
                     Qt::NoButton, Qt::LeftButton, Qt::NoModifier);
    QMouseEvent release(QEvent::MouseButtonRelease, QPointF(400, 240),
                        QPointF(400, 240), Qt::LeftButton, Qt::NoButton,
                        Qt::NoModifier);
    tool->mousePressEvent(&press);
    tool->mouseMoveEvent(&move);
    tool->mouseReleaseEvent(&release);
    EXPECT_EQ(editor.molecule().atomCount(), 10 - 2 * order);
    int carbonBonds = 0;
    for (Index i = 0; i < editor.molecule().bondCount(); ++i) {
      const auto bond = editor.molecule().bond(i);
      if (bond.atom1().atomicNumber() == 6 &&
          bond.atom2().atomicNumber() == 6) {
        ++carbonBonds;
        EXPECT_EQ(bond.order(), order);
      }
    }
    EXPECT_EQ(carbonBonds, 1);
    editor.undo();
    EXPECT_EQ(editor.molecule().atomCount(), 0);
    editor.redo();
    EXPECT_EQ(editor.molecule().atomCount(), 10 - 2 * order);
  }
}

TEST_F(WebEditorTest, FailedImportsPreserveDocumentAndUndo)
{
  editor.setDrawOptions({ { "adjustHydrogens", false } });
  clickAtom();
  const QJsonValue before = editor.exportMolecule("cjson")["text"];
  for (const QString format : { "cjson", "mol", "sdf", "xyz", "smi" }) {
    EXPECT_FALSE(editor.loadMolecule("not a molecule", format)["ok"].toBool());
    EXPECT_EQ(editor.exportMolecule("cjson")["text"], before);
    EXPECT_TRUE(editor.state()["canUndo"].toBool());
  }
  editor.undo();
  EXPECT_EQ(editor.molecule().atomCount(), 0);
}

TEST_F(WebEditorTest, DeleteAndSaveState)
{
  editor.setDrawOptions({ { "adjustHydrogens", false } });
  clickAtom();
  editor.markSaved();
  EXPECT_FALSE(editor.state()["modified"].toBool());
  editor.molecule().atom(0).setSelected(true);
  editor.deleteSelection();
  EXPECT_EQ(editor.molecule().atomCount(), 0);
  editor.undo();
  EXPECT_EQ(editor.molecule().atomCount(), 1);
  EXPECT_FALSE(editor.state()["modified"].toBool());
  editor.newMolecule();
  EXPECT_FALSE(editor.state()["canUndo"].toBool());
}

TEST_F(WebEditorTest, DeleteSelectionRespectsLockedAtomsAndNeighbours)
{
  ASSERT_TRUE(
    editor
      .loadMolecule("3\nLocked neighbour\nC 0 0 0\nO 1.4 0 0\nN 5 0 0\n",
                    "xyz")["ok"]
      .toBool());
  editor.molecule().addBond(0, 1, 1);
  auto info = editor.molecule().layerInfo();
  info->layer.addLayer();
  info->locked.push_back(true);
  info->visible.push_back(true);
  editor.molecule().setLayer(1, 1);

  // Exercise locks from an imported document, including an unlocked selected
  // atom bonded to a locked atom and a mixed safe/unsafe selection.
  const auto document = editor.exportMolecule("cjson")["text"].toString();
  ASSERT_TRUE(editor.loadMolecule(document, "cjson")["ok"].toBool());
  for (const auto& selected :
       std::vector<std::vector<Index>>{ { 1 }, { 0 }, { 0, 2 } }) {
    for (Index i = 0; i < editor.molecule().atomCount(); ++i)
      editor.molecule().setAtomSelected(i, false);
    for (Index i : selected)
      editor.molecule().setAtomSelected(i, true);
    const QJsonValue before = editor.exportMolecule("cjson")["text"];
    editor.deleteSelection();
    EXPECT_EQ(editor.exportMolecule("cjson")["text"], before);
    EXPECT_FALSE(editor.state()["canUndo"].toBool());
    EXPECT_FALSE(editor.state()["modified"].toBool());
  }

  // A safe selection in the same document still deletes as one undo step.
  editor.molecule().setAtomSelected(0, false);
  editor.deleteSelection();
  EXPECT_EQ(editor.molecule().atomCount(), 2);
  EXPECT_EQ(editor.molecule().bondCount(), 1);
  editor.undo();
  EXPECT_EQ(editor.molecule().atomCount(), 3);
  EXPECT_EQ(editor.molecule().bondCount(), 1);
  EXPECT_FALSE(editor.state()["canUndo"].toBool());
  EXPECT_FALSE(editor.state()["modified"].toBool());
}

TEST_F(WebEditorTest, DeleteSelectionRespectsActiveLayerLock)
{
  editor.setDrawOptions({ { "adjustHydrogens", false } });
  clickAtom();
  editor.molecule().undoMolecule()->undoStack().clear();
  editor.molecule().setAtomSelected(0, true);
  editor.molecule().layerInfo()->locked[0] = true;
  editor.deleteSelection();
  EXPECT_EQ(editor.molecule().atomCount(), 1);
  EXPECT_FALSE(editor.state()["canUndo"].toBool());
  EXPECT_FALSE(editor.state()["modified"].toBool());
}

TEST_F(WebEditorTest, ReplacingDocumentReleasesLayerState)
{
  for (int i = 0; i < 20; ++i) {
    clickAtom();
    std::weak_ptr<Core::MoleculeInfo> layers =
      Core::LayerManager::getMoleculeInfo(&editor.molecule());
    editor.newMolecule();
    EXPECT_TRUE(layers.expired());
    EXPECT_EQ(editor.molecule().atomCount(), 0);
  }
}
int main(int argc, char** argv)
{
  QApplication app(argc, argv);
  app.setApplicationName("AvogadroWebTests");
  testing::InitGoogleTest(&argc, argv);
  return RUN_ALL_TESTS();
}
