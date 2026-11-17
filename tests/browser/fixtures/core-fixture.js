// SPDX-License-Identifier: BSD-3-Clause
import { createAvogadroEditor } from './core/avogadro-editor.js';

const viewport = document.querySelector('#viewport');
viewport.style.width = '640px';
viewport.style.height = '400px';
globalThis.coreReady = createAvogadroEditor(viewport);
