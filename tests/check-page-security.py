#!/usr/bin/env python3
# SPDX-License-Identifier: BSD-3-Clause
"""Enforce the editor's markup and JavaScript sink rules on checked-in sources."""

import re
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
# Match property names even in computed access with a literal string.
SINK = re.compile(
    r"\b(?:innerHTML|outerHTML|insertAdjacentHTML|eval)\b|"
    r"""\bdocument\s*(?:\.\s*|\[\s*['"])write(?:ln)?\b"""
)


class EditorHTML(HTMLParser):
    def handle_starttag(self, tag, attributes):
        attrs = dict(attributes)
        line = self.getpos()[0]
        if tag == "script" and not attrs.get("src"):
            errors.append(f"{path}:{line}: inline script")
        if "style" in attrs or any(name.startswith("on") for name in attrs):
            errors.append(f"{path}:{line}: inline style or event handler")
        if tag == "meta" and attrs.get("http-equiv", "").lower() == "content-security-policy":
            self.policies.append(attrs.get("content", ""))


errors = []
for path in sorted((ROOT / "web").rglob("*.js")):
    source = path.read_text(encoding="utf-8")
    for match in SINK.finditer(source):
        line = source.count("\n", 0, match.start()) + 1
        errors.append(f"{path}:{line}: forbidden DOM or JavaScript sink {match[0]}")
path = ROOT / "web/editor/index.html"
parser = EditorHTML()
parser.policies = []
parser.feed(path.read_text(encoding="utf-8"))
if len(parser.policies) != 1 or not parser.policies[0]:
    errors.append(f"{path}: expected one Content-Security-Policy")
if errors:
    raise SystemExit("\n".join(errors))
