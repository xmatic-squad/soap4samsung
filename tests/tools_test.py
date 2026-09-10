"""Public builds must never inherit a developer's private files or session."""

import importlib.util
import io
import json
import os
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


def load_tool(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / "tools" / (name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


package = load_tool("package")
certificates = load_tool("certificates")


class PackageTests(unittest.TestCase):
    def test_only_public_assets_and_generated_version_enter_package(self):
        with tempfile.TemporaryDirectory() as directory:
            app = Path(directory) / "app"
            stage = Path(directory) / "stage"
            app.mkdir()
            stage.mkdir()
            for name in package.PUBLIC_FILES:
                (app / name).write_text("public asset", encoding="utf-8")
            for name in ("config.local.js", "personal.js", "author.p12", "profiles.xml", ".env"):
                (app / name).write_text("must stay private", encoding="utf-8")
            (app / "private").mkdir()
            (app / "private" / "settings.js").write_text("must stay private", encoding="utf-8")
            package.stage_app(app, stage, "1.2.3")
            self.assertEqual({p.name for p in stage.iterdir()}, set(package.PUBLIC_FILES) | {"config.local.js"})
            generated = (stage / "config.local.js").read_text(encoding="utf-8")
            self.assertEqual(json.loads(generated.removeprefix("window.SOAP_CONFIG=").strip().removesuffix(";")), {"version": "1.2.3"})
            self.assertTrue(all(b"must stay private" not in p.read_bytes() for p in stage.iterdir()))

    def test_public_asset_symlink_cannot_package_an_external_file(self):
        with tempfile.TemporaryDirectory() as directory:
            app = Path(directory) / "app"
            stage = Path(directory) / "stage"
            app.mkdir()
            stage.mkdir()
            external = Path(directory) / "external.js"
            external.write_text("private", encoding="utf-8")
            try:
                (app / "api.js").symlink_to(external)
            except OSError:
                self.skipTest("Creating symlinks requires permission on this platform")
            with self.assertRaisesRegex(SystemExit, "symlinked"):
                package.stage_app(app, stage, "1.2.3")

    def test_tizen_resolution_prefers_explicit_then_sdk_then_path(self):
        sdk = Path("/example/sdk")
        sdk_cli = str(sdk / "tools/ide/bin/tizen")
        with patch.dict(os.environ, {"TIZEN_STUDIO_PATH": str(sdk)}):
            with patch.object(package.shutil, "which", side_effect=lambda value: value) as which:
                self.assertEqual(package.resolve_tizen("/example/custom/tizen"), "/example/custom/tizen")
                which.assert_called_once_with("/example/custom/tizen")
            with patch.object(package.shutil, "which", side_effect=lambda value: value):
                self.assertEqual(package.resolve_tizen(), sdk_cli)
            with patch.object(package.shutil, "which", side_effect=lambda value: "/system/tizen" if value == "tizen" else None):
                self.assertEqual(package.resolve_tizen(), "/system/tizen")

    def test_missing_explicit_tizen_does_not_silently_sign_with_other_sdk(self):
        with patch.object(package.shutil, "which", return_value=None):
            with self.assertRaisesRegex(SystemExit, "Tizen CLI missing"):
                package.resolve_tizen("/missing/tizen")


class CertificateTests(unittest.TestCase):
    def test_backup_defaults_private_and_rejects_public_tree(self):
        self.assertTrue(certificates.ARCHIVE.is_relative_to(ROOT / ".local"))
        certificates.require_private_destination(ROOT / ".local" / "test.tar.gpg")
        with tempfile.TemporaryDirectory() as directory:
            certificates.require_private_destination(Path(directory) / "test.tar.gpg")
        with self.assertRaisesRegex(SystemExit, "вне репозитория"):
            certificates.require_private_destination(ROOT / "certificates" / "test.tar.gpg")

    def test_snapshot_selects_only_the_requested_profile(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            (path / "author.p12").write_bytes(b"example author")
            (path / "distributor.p12").write_bytes(b"example distributor")
            profiles = path / "profiles.xml"
            profiles.write_text(
                '<profiles version="3.1"><profile name="SomeoneElse"><profileitem distributor="0" key="missing.p12" /></profile>'
                '<profile name="MyTV"><profileitem distributor="0" key="author.p12" /><profileitem distributor="1" key="distributor.p12" /></profile></profiles>',
                encoding="utf-8",
            )
            data, count = certificates.snapshot(profiles, "MyTV", path / "no-extra-files")
            with tarfile.open(fileobj=io.BytesIO(data), mode="r:") as archive:
                names = archive.getnames()
                self.assertEqual(count, len(names))
                self.assertEqual(set(names), {"profile/profiles.xml", "active-profile/author.p12", "active-profile/distributor.p12", "manifest.json"})
                profile = archive.extractfile("profile/profiles.xml").read()
                self.assertIn(b'MyTV', profile)
                self.assertNotIn(b'SomeoneElse', profile)

    def test_restore_rejects_archive_path_traversal_before_writing(self):
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode="w") as archive:
            member = tarfile.TarInfo("../outside")
            member.size = 1
            archive.addfile(member, io.BytesIO(b"x"))
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "restore"
            with self.assertRaisesRegex(SystemExit, "Недопустимый путь"):
                certificates.restore(buffer.getvalue(), destination)
            self.assertFalse(destination.exists())


if __name__ == "__main__":
    unittest.main()
