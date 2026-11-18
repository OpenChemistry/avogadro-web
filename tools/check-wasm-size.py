#!/usr/bin/env python3
"""Record release asset sizes in bytes and enforce the kit's size budgets."""

import argparse
import json
import os
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("kit")
parser.add_argument("package", type=Path)
parser.add_argument("archive", type=Path)
args = parser.parse_args()

budgets = json.loads(Path(__file__).with_name("wasm-size-budgets.json").read_text())
limits = budgets[args.kit]
lines = [
    f"### Release size — `{args.kit}`",
    "",
    "| Asset | Bytes | Budget |",
    "| --- | ---: | ---: |",
]
failed = False
sizes = {}
for asset, maximum in limits.items():
    path = args.archive if asset == "package ZIP" else args.package / asset
    size = path.stat().st_size
    sizes[asset] = size
    lines.append(f"| {asset} | {size:,} | {maximum:,} |")
    failed |= size > maximum

summary = "\n".join(lines) + "\n"
print(summary)
if summary_path := os.environ.get("GITHUB_STEP_SUMMARY"):
    with Path(summary_path).open("a") as output:
        output.write(summary)
args.archive.with_suffix(".sizes.json").write_text(json.dumps(sizes, indent=2) + "\n")
if failed:
    parser.exit(1, "WASM release exceeds its size budget.\n")
