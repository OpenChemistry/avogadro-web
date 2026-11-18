#!/usr/bin/env python3
"""Verify a freshly installed WASM web profile (no compilation required)."""
import argparse
import re
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('build', type=Path)
parser.add_argument(
    'kit', nargs='?', choices=['wasm_multithread', 'wasm_singlethread'], default='wasm_multithread'
)
parser.add_argument('--action-plugins', action='store_true',
                    help='check a build using the optional action plugin companion revision')
args = parser.parse_args()
build = args.build.resolve()
libs = build / 'avogadrolibs'
app = build / 'avogadro-web'
prefix = build / 'prefix'
threaded = args.kit == 'wasm_multithread'
thread_feature = 'ON' if threaded else 'OFF'
for project in (build, libs, app):
    cache = (project / 'CMakeCache.txt').read_text()
    assert re.search(rf'^QT_FEATURE_thread:INTERNAL={thread_feature}$', cache, re.MULTILINE), project

excluded = ['pythonscript.cpp', 'packagemanager.cpp', 'interfacescript.cpp',
            'interfacewidget.cpp', '/qtplugins/openbabel/', '/qtplugins/forcefield/obmmenergy.cpp',
            '/qtplugins/forcefield/scriptenergy.cpp',
            '/qtplugins/quantuminput/', '/qtplugins/playertool/', '/molequeue/']
compiled = '\n'.join(line for line in (libs / 'build.ninja').read_text().splitlines()
                     if line.startswith('build ') and 'CXX_COMPILER' in line)
for source in excluded:
    assert source not in compiled, f'Disabled source compiled: {source}'
plugins = re.findall(r'Q_IMPORT_PLUGIN\((\w+)Factory\)',
                    (libs / 'avogadro/qtplugins/avogadrostaticqtplugins.h').read_text())
expected_plugins = {
    'Navigator', 'Editor', 'Selection', 'AlignTool', 'BondCentric', 'LabelEditor',
    'Manipulator', 'MeasureTool', 'BallStick', 'Cartoons', 'CrystalScene', 'Label', 'Licorice', 'VanDerWaals',
    'Wireframe',
}
if args.action_plugins:
    expected_plugins.update(['Select', 'Bonding', 'Hydrogens'])
if threaded:
    expected_plugins.update(['AutoOpt', 'Forcefield', 'SurfaceRender', 'Surfaces', 'Orbitals'])
assert set(plugins) == expected_plugins, plugins
for name in ['pythonscript', 'packagemanager', 'interfacescript', 'interfacewidget']:
    assert not (prefix / f'include/avogadro/qtgui/{name}.h').exists(), name
config = (prefix / 'lib/cmake/avogadrolibs/AvogadroLibsConfig.cmake').read_text()
assert re.search(r'set\(AvogadroLibs_USE_SUBPROCESS\s+"OFF"\)', config)
exports = (prefix / 'lib/cmake/avogadrolibs/AvogadroLibsTargets.cmake').read_text()
for name in ['Avogadro::MoleQueue', 'Avogadro::OpenBabel', 'LibArchive']:
    assert name not in exports, name
for source in ['/avogadro/mainwindow.cpp', '/avogadro/rpc/', 'rpclistener.cpp']:
    assert source not in (app / 'build.ninja').read_text(), source
for target in ['avogadroapp', 'libarchive', 'molequeue', 'jkqtplotter', 'qttesting']:
    assert not re.search(rf'^build {target}:', (build / 'build.ninja').read_text(), re.MULTILINE), target
print(f'PASS ({args.kit}): expected Qt thread setting and plugins; '
      'no disabled sources, headers, exports, external projects or desktop RPC')
