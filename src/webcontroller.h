// SPDX-License-Identifier: BSD-3-Clause
#ifndef AVOGADRO_WEB_CONTROLLER_H
#define AVOGADRO_WEB_CONTROLLER_H

#include <QJsonObject>
#include <QMap>
#include <QObject>
#include <QTimer>
#include <memory>

namespace Avogadro {
namespace QtGui {
class Molecule;
class ToolPlugin;
class ExtensionPlugin;
class LayerModel;
}
namespace QtOpenGL {
class GLWidget;
}
namespace Web {

// One document per application instance. The viewport must outlive this object.
class WebController : public QObject
{
  Q_OBJECT
public:
  explicit WebController(QtOpenGL::GLWidget& view, QObject* parent = nullptr);
  ~WebController() override;
  QJsonObject state() const;
  QJsonObject captureViewport() const;
  QtGui::Molecule& molecule() const;
  bool setTool(const QString& name);
  bool setDisplayStyle(const QString& id, bool enabled);
  bool alignPickedAtoms(const QString& axis);
  bool setPickedLabel(const QString& label);
  QJsonObject runAction(const QString& id, const QJsonObject& options);
  bool calculate(const QString& command, const QVariantMap& options);
  bool setDrawOptions(const QVariantMap& options);
  void newMolecule();
  QJsonObject loadMolecule(const QString& text, const QString& format);
  QJsonObject insertFragment(const QString& sdf);
  QJsonObject exportMolecule(const QString& format) const;
  void markSaved();
  void deleteSelection();
  void undo();
  void redo();
  void resetCamera();
  bool setTheme(const QString& theme);
  void zoom(double delta);
  void pan(double x, double y);
  void touchPointer(const QString& phase, double x, double y, int modifiers);
signals:
  void stateChanged();

private:
  bool eventFilter(QObject* watched, QEvent* event) override;
  void enableDisplayStyles(const QStringList& names);
  QJsonObject properties(const QString& id, const QJsonValue& index) const;
  QJsonObject changeCell(const QString& id, const QJsonArray& values);
  void addActionPlugin(const QString& id);
  bool actionEnabled(const QString& id) const;
  void addCalculator(const QString& id);
  void finishCalculation(const QString& message, bool error);
  void replaceMolecule(std::unique_ptr<QtGui::Molecule> molecule);
  QtOpenGL::GLWidget& m_view;
  std::unique_ptr<QtGui::Molecule> m_molecule;
  std::unique_ptr<QtGui::LayerModel> m_layers;
  QMap<QString, QtGui::ToolPlugin*> m_tools;
  QMap<QString, QtGui::ExtensionPlugin*> m_calculators;
  QMap<QString, QtGui::ExtensionPlugin*> m_actionPlugins;
  QMap<QString, QString> m_actionLabels;
  QMap<QString, QString> m_actionOwners;
  QTimer m_calculationTimeout;
  QString m_activeCalculator;
  bool m_calculating = false;
  bool m_touchPressed = false;
  QString m_calculationMessage;
  bool m_calculationError = false;
  QString m_tool = QStringLiteral("draw");
};
} // namespace Web
} // namespace Avogadro
#endif
