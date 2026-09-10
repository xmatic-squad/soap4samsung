#!/usr/bin/env python3
"""Prepare an unsigned widget, or sign it with an existing Samsung profile."""

import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import xml.etree.ElementTree as ET
import zipfile

ROOT = Path(__file__).resolve().parents[1]
# Deliberately package only public application assets. New assets must be added
# here explicitly; ignored files and a developer's local config cannot leak in.
PUBLIC_FILES = (
    "api.js", "config.xml", "icon.png", "icon.svg", "index.html", "main.js",
    "player.js", "styles.css",
)


def resolve_tizen(explicit=None):
    if explicit:
        candidates = [str(Path(explicit).expanduser())]
    else:
        candidates = []
        sdk = os.environ.get("TIZEN_STUDIO_PATH")
        if sdk:
            candidates.extend(str(Path(sdk).expanduser() / "tools/ide/bin" / name)
                              for name in ("tizen", "tizen.bat"))
        candidates.extend(("tizen", "tizen.bat"))
        candidates.extend(str(Path.home() / "tizen-studio/tools/ide/bin" / name)
                          for name in ("tizen", "tizen.bat"))
    for candidate in candidates:
        executable = shutil.which(candidate)
        if executable:
            return executable
    raise SystemExit("Tizen CLI missing. Use --tizen, set TIZEN_STUDIO_PATH, or add tizen to PATH.")


def stage_app(app, stage, version):
    for name in PUBLIC_FILES:
        source = app / name
        if source.is_symlink() or not source.is_file():
            raise SystemExit("Missing or symlinked public application asset: " + name)
        shutil.copyfile(source, stage / name)
    (stage / "config.local.js").write_text(
        "window.SOAP_CONFIG=" + json.dumps({"version": version}) + ";\n", encoding="utf-8"
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", help="Existing Samsung certificate profile; otherwise build unsigned")
    parser.add_argument("--tizen", help="Tizen CLI path; otherwise use TIZEN_STUDIO_PATH, PATH, or ~/tizen-studio")
    args = parser.parse_args()
    app = ROOT / "app"
    manifest = ET.parse(app / "config.xml").getroot()
    version = json.loads((ROOT / "package.json").read_text())["version"]
    if manifest.get("version") != version:
        raise SystemExit("Version mismatch: update package.json and app/config.xml together.")
    out = ROOT / ".local"
    out.mkdir(mode=0o700, exist_ok=True)
    out.chmod(0o700)
    with tempfile.TemporaryDirectory(prefix="package-", dir=out) as temporary:
        stage = Path(temporary)
        stage_app(app, stage, version)
        for path in stage.rglob("*.js"):
            subprocess.run(["node", "--check", str(path)], check=True, capture_output=True)
        if args.profile:
            tizen = resolve_tizen(args.tizen)
            result = subprocess.run(
                [tizen, "package", "-t", "wgt", "-s", args.profile, "--", str(stage)],
                capture_output=True, text=True,
            )
            if result.returncode:
                # Signature tools can expose paths/profile details; leave their own logs local.
                raise SystemExit("Signing failed. Check the Tizen CLI log and certificate profile.")
            packages = list(stage.glob("*.wgt"))
            if len(packages) != 1:
                raise SystemExit("Expected one signed widget from Tizen CLI.")
            artifact = out / "Soap4Samsung.wgt"
            shutil.copyfile(packages[0], artifact)
        else:
            artifact = out / "Soap4Samsung-unsigned.wgt"
            with zipfile.ZipFile(artifact, "w", zipfile.ZIP_DEFLATED) as archive:
                for source in sorted(stage.rglob("*")):
                    if source.is_file():
                        archive.write(source, source.relative_to(stage))
        artifact.chmod(0o600)
        print(f"{'Signed' if args.profile else 'Unsigned'} package: {artifact}")
        print(f"Size: {artifact.stat().st_size} bytes")


if __name__ == "__main__":
    main()
