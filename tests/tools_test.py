"""Public builds must never inherit a developer's private files or session."""

import importlib.util
from contextlib import ExitStack
import http.client
import io
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import threading
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
preview = load_tool("preview")


class PreviewProxyTests(unittest.TestCase):
    def test_ordinary_mode_keeps_proxy_transport_and_headers(self):
        with ExitStack() as stack:
            build = stack.enter_context(patch.object(preview.urllib.request, "build_opener"))
            response = build.return_value.open.return_value.__enter__.return_value
            response.status = 200
            response.read.return_value = b'{"ok":1}'
            server = preview.create_server(port=0)
            stack.callback(server.server_close)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            stack.callback(thread.join)
            stack.callback(server.shutdown)
            self.assertIsNone(server.mock_data)
            build.assert_called_once()
            for path, upstream, mime in (("/api/v2/auth/", preview.API + "/auth/", "application/json"),
                                         ("/site/login/", preview.SITE + "/login/", "text/html; charset=UTF-8")):
                connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=5)
                try:
                    connection.request("POST", path, "login=fictional&password=anything", {"X-API-TOKEN": "synthetic"})
                    reply = connection.getresponse()
                    self.assertEqual(reply.status, 200)
                    self.assertEqual(reply.getheader("Content-Type"), mime)
                    self.assertIsNone(reply.getheader("Content-Security-Policy"))
                    self.assertEqual(reply.read(), b'{"ok":1}')
                finally:
                    connection.close()
                request = build.return_value.open.call_args.args[0]
                self.assertEqual(request.full_url, upstream)
                self.assertEqual(request.method, "POST")
                self.assertEqual(request.data, b"login=fictional&password=anything")
                self.assertEqual(request.get_header("Content-type"), "application/x-www-form-urlencoded")
                self.assertEqual(request.get_header("X-api-token"), None if path.startswith("/site/") else "synthetic")
                self.assertEqual(build.return_value.open.call_args.kwargs, {"timeout": 20})


class PreviewMockTests(unittest.TestCase):
    def setUp(self):
        stack = ExitStack()
        self.addCleanup(stack.close)
        # Local requests below use http.client, so every urllib entry point can
        # fail closed, including the opener used by the ordinary proxy mode.
        self.urlopen = stack.enter_context(patch.object(preview.urllib.request, "urlopen", side_effect=AssertionError("Network forbidden")))
        self.build_opener = stack.enter_context(patch.object(preview.urllib.request, "build_opener", side_effect=AssertionError("Network forbidden")))
        self.opener_open = stack.enter_context(patch.object(preview.urllib.request.OpenerDirector, "open", side_effect=AssertionError("Network forbidden")))
        directory = stack.enter_context(tempfile.TemporaryDirectory())
        self.sample = Path(directory) / "sample.mp4"
        self.sample_bytes = bytes(range(256)) * 600  # Generated, never a binary fixture.
        self.sample.write_bytes(self.sample_bytes)
        self.server = preview.create_server(port=0, mock=True, sample_video=self.sample)
        stack.callback(self.server.server_close)
        thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        thread.start()
        stack.callback(thread.join)
        stack.callback(self.server.shutdown)

    def request(self, path, method="GET", body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        try:
            connection.request(method, path, body=body, headers=headers or {})
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            connection.close()

    def api(self, route, method="GET", body=None):
        status, headers, data = self.request("/api/v2" + route, method, body)
        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Type"], "application/json")
        return json.loads(data)

    def test_auth_accepts_nonempty_credentials_and_rejects_empty(self):
        response = self.api("/auth/", "POST", "login=fictional&password=anything")
        self.assertEqual(response["ok"], 1)
        self.assertTrue(isinstance(response["token"], str) and response["token"])
        self.assertEqual(self.api("/auth/check/")["logged"], 1)
        self.assertEqual(self.request("/site/login/", "POST", "login=fictional&password=anything")[0], 200)
        for route in ("/api/v2/auth/", "/site/login/"):
            for body in ("", "login=fictional", "password=anything", "login=%20&password=anything"):
                with self.subTest(route=route, body=body):
                    self.assertEqual(self.request(route, "POST", body)[0], 401)

    def test_catalog_and_episode_shapes_cover_navigation_edge_cases(self):
        shows = self.api("/soap/")
        my = self.api("/soap/my/")
        movies = self.api("/movies/")
        self.assertGreaterEqual(len(shows), 150)
        self.assertEqual(len(my), 5)
        self.assertEqual(my, shows[:5])
        self.assertGreater(len({show["unwatched"] for show in my}), 1)
        self.assertEqual(len({show["sid"] for show in shows}), len(shows))
        self.assertTrue(any("covers" not in show for show in shows))
        self.assertTrue(any("imdb_rating" not in show for show in shows))
        for show in shows:
            for key in ("imdb_rating", "kinopoisk_rating", "soap_rating"):
                if key in show:
                    self.assertIsInstance(show[key], str)
                    self.assertTrue(0 < float(show[key]) <= 10)
        self.assertGreaterEqual(len(movies), 40)
        self.assertEqual(len({movie["id"] for movie in movies}), len(movies))
        for movie in movies:
            self.assertGreater(movie["runtime"], 0)
            self.assertNotIn("sid", movie)
            for key in ("imdb_rating", "kinopoisk_rating", "soap_rating"):
                if key in movie:
                    self.assertIsInstance(movie[key], (int, float))
                    self.assertTrue(0 < movie[key] <= 10)
        detail = self.api("/episodes/1/")
        episodes = detail["episodes"]
        seasons = {item["season"] for item in episodes}
        self.assertGreaterEqual(len(seasons), 3)
        self.assertGreater(sum(item["season"] == 3 for item in episodes), 16)
        self.assertEqual([item["episode"] for item in episodes if item["season"] == 2], [1, 2, 4, 5])
        self.assertNotIn(2, [cover["season"] for cover in detail["covers"]])
        self.assertTrue(any(not any(file["translate"] == 4 for file in item["files"]) for item in episodes))
        self.assertTrue(any(item["watched"] for item in episodes))
        self.assertTrue(any(not item["watched"] for item in episodes))
        for item in episodes:
            self.assertNotIn("sid", item)
            for file in item["files"]:
                self.assertTrue({"eid", "hash", "quality", "translate"} <= file.keys())
                self.assertIn(file["quality"], (1, 2, 3, 4))
                self.assertTrue(file["hash"])
        self.assertEqual(shows, preview.MockData(self.server.server_port).shows)

    def test_watching_season_then_show_updates_episodes_and_both_catalogs(self):
        other = self.api("/episodes/2/")
        self.assertEqual(self.api("/episodes/watch/full/1/1/", "POST")["ok"], 1)
        episodes = self.api("/episodes/1/")["episodes"]
        self.assertTrue(all(item["watched"] == 1 for item in episodes if item["season"] == 1))
        self.assertTrue(any(not item["watched"] for item in episodes if item["season"] != 1))
        for route in ("/soap/", "/soap/my/"):
            self.assertEqual(self.api(route)[0]["unwatched"], sum(not item["watched"] for item in episodes))
        for _ in range(2):  # Repeating the same mark is idempotent.
            self.assertEqual(self.api("/episodes/watch/full/1/", "POST"), {"ok": 1})
        self.assertTrue(all(item["watched"] == 1 for item in self.api("/episodes/1/")["episodes"]))
        self.assertEqual(self.api("/soap/my/")[0]["unwatched"], 0)
        self.assertEqual(self.api("/soap/")[0]["unwatched"], 0)
        self.assertEqual(self.api("/episodes/2/"), other)
        self.assertGreater(preview.MockData(self.server.server_port).shows[0]["unwatched"], 0)

    def test_sample_whole_file_and_single_byte_ranges(self):
        size = len(self.sample_bytes)
        cases = ((None, 200, 0, size - 1), ("bytes=0-0", 206, 0, 0),
                 ("bytes=7-42", 206, 7, 42), ("bytes=65530-131080", 206, 65530, 131080),
                 ("bytes=150000-", 206, 150000, size - 1), ("bytes=-9", 206, size - 9, size - 1),
                 (f"bytes=-{size + 10}", 206, 0, size - 1),
                 (f"bytes=10-{size + 10}", 206, 10, size - 1))
        for value, expected_status, start, end in cases:
            with self.subTest(range=value):
                status, headers, body = self.request("/mock/sample", headers={"Range": value} if value else {})
                self.assertEqual(status, expected_status)
                self.assertEqual(headers["Content-Type"], "video/mp4")
                self.assertEqual(headers["Accept-Ranges"], "bytes")
                self.assertEqual(int(headers["Content-Length"]), end - start + 1)
                self.assertEqual(body, self.sample_bytes[start:end + 1])
                if value:
                    self.assertEqual(headers["Content-Range"], f"bytes {start}-{end}/{size}")
                else:
                    self.assertNotIn("Content-Range", headers)
        for value in (f"bytes={size}-", "bytes=8-3", "bytes=-0", "bytes=-", "bytes=0-1,3-4", "items=0-1", "bytes=bad"):
            with self.subTest(range=value):
                status, headers, body = self.request("/mock/sample", headers={"Range": value})
                self.assertEqual(status, 416)
                self.assertEqual(headers["Content-Range"], f"bytes */{size}")
                self.assertEqual(body, b"")
        self.sample.write_bytes(b"")
        self.assertEqual(self.request("/mock/sample")[2], b"")
        self.assertEqual(self.request("/mock/sample", headers={"Range": "bytes=0-"})[0], 416)

    def test_play_without_sample_returns_local_url_then_404(self):
        file = self.api("/episodes/1/")["episodes"][0]["files"][0]
        playback = self.api(f'/play/episode/{file["eid"]}/', "POST", "eid=ignored&hash=ignored")
        self.assertEqual(playback["ok"], 1)
        self.assertEqual(playback["start_from"], 0)
        self.assertEqual(playback["stream"], f"http://127.0.0.1:{self.server.server_port}/mock/sample")
        self.server.sample_video = None
        self.assertEqual(self.request("/mock/sample")[0], 404)

    def test_mock_never_uses_network_and_serves_local_assets(self):
        self.api("/auth/", "POST", "login=fictional&password=anything")
        self.api("/auth/check/")
        for route in ("/soap/my/", "/soap/", "/movies/", "/episodes/1/"):
            self.api(route)
        self.api("/play/episode/101011/", "POST")
        self.api("/episodes/watch/full/1/1/", "POST")
        self.api("/episodes/watch/full/1/", "POST")
        self.assertEqual(self.request("/site/login/", "POST", "login=fictional&password=anything")[0], 200)
        self.assertEqual(self.request("/site/movies/1/")[0], 200)
        for path in ("/", "/api.js", "/config.local.js", "/mock/sample", "/mock/cover/1.svg"):
            status, headers, body = self.request(path)
            self.assertEqual(status, 200)
            self.assertTrue(body)
            self.assertIn("connect-src 'self'", headers["Content-Security-Policy"])
        status, headers, body = self.request("/mock/cover/1.svg")
        self.assertEqual(headers["Content-Type"], "image/svg+xml")
        self.assertIn(b"<svg", body)
        self.assertNotIn(b"https://", body)
        self.assertFalse(hasattr(self.server, "api_opener"))
        self.urlopen.assert_not_called()
        self.build_opener.assert_not_called()
        self.opener_open.assert_not_called()

    def test_foreign_host_and_origin_are_rejected_before_mock_processing(self):
        for headers in ({"Host": "attacker.example"}, {"Origin": "http://attacker.example"}, {"Origin": "null"}):
            for path, method in (("/", "GET"), ("/api/v2/soap/", "GET"),
                                 ("/api/v2/auth/", "POST"), ("/mock/sample", "GET"),
                                 ("/mock/cover/1.svg", "GET"), ("/site/login/", "POST")):
                with self.subTest(headers=headers, path=path):
                    self.assertEqual(self.request(path, method, headers=headers)[0], 403)
        origin = f"http://127.0.0.1:{self.server.server_port}"
        self.assertEqual(self.request("/api/v2/soap/", headers={"Origin": origin})[0], 200)
        self.assertEqual(self.server.server_address[0], "127.0.0.1")

    def test_unknown_endpoints_and_wrong_methods_do_not_fall_through_to_proxy(self):
        for path, method in (("/api/v2/arbitrary/", "GET"), ("/api/v2/auth/", "GET"),
                             ("/api/v2/soap/", "POST"), ("/site/login/", "GET"),
                             ("/site/movies/1/", "POST"), ("/api/v2/episodes/999/", "GET"),
                             ("/api/v2/episodes/watch/full/999/", "POST"),
                             ("/api/v2/episodes/watch/full/1/999/", "POST"),
                             ("/api/v2/play/episode/999/", "POST"), ("/site/movies/999/", "GET"),
                             ("/mock/cover/not-a-number.svg", "GET")):
            with self.subTest(path=path, method=method):
                self.assertEqual(self.request(path, method)[0], 404)
        self.assertEqual(self.request("/api/v2/auth/", "POST", headers={"Content-Length": "invalid"})[0], 400)
        self.assertEqual(self.request("/api/v2/auth/", "POST", headers={"Content-Length": "16385"})[0], 413)

    def test_mock_delay_is_applied_to_api_and_assets(self):
        self.server.mock_delay_ms = 123
        with patch.object(preview.time, "sleep") as sleep:
            self.api("/soap/")
            self.request("/site/movies/1/")
            self.request("/mock/cover/1.svg")
            self.request("/mock/sample")
            self.request("/api.js")
            self.assertEqual(sleep.call_count, 4)
            sleep.assert_called_with(0.123)
        with self.assertRaisesRegex(ValueError, "nonnegative"):
            preview.create_server(port=0, mock=True, mock_delay_ms=-1)
        with self.assertRaisesRegex(ValueError, "require --mock"):
            preview.create_server(port=0, sample_video=self.sample)
        with self.assertRaisesRegex(ValueError, "existing file"):
            preview.create_server(port=0, mock=True, sample_video=self.sample.parent / "missing.mp4")

    def test_real_api_client_parses_mock_http_responses(self):
        # Feed actual HTTP response bodies through the unmodified client. Its
        # transport is stubbed only to avoid adding a Node XHR dependency.
        responses = {}
        for route in ("/auth/", "/auth/check/", "/soap/my/", "/soap/", "/movies/", "/episodes/1/",
                      "/play/episode/101014/", "/episodes/watch/full/1/1/", "/episodes/watch/full/1/"):
            method = "POST" if route in ("/auth/", "/play/episode/101014/", "/episodes/watch/full/1/1/", "/episodes/watch/full/1/") else "GET"
            responses[route] = self.api(route, method, "login=fictional&password=anything" if route == "/auth/" else None)
        responses["site/login/"] = self.request("/site/login/", "POST", "login=fictional&password=anything")[2].decode()
        responses["site/movies/1/"] = self.request("/site/movies/1/")[2].decode()
        script = r'''
const assert = require("node:assert/strict");
const fs = require("node:fs");
const SoapApi = require("./app/api.js");
const responses = JSON.parse(fs.readFileSync(0, "utf8"));
const api = new SoapApi({baseUrl: "/api/v2", siteBaseUrl: "/site"});
let parsedMovie = false;
api._request = function (method, path, form, anonymous, transport) {
  if (transport && transport.public) {
    assert.match(transport.url, /^https:\/\/cdn-mock\.soap4youand\.me\/hls\/mock-1\/master\.m3u8$/);
    parsedMovie = true; // Reaching this point proves parseMoviePlayer succeeded.
    return Promise.reject(Object.assign(new Error("Mock has no HLS"), {code: "MOCK_NO_HLS"}));
  }
  const key = transport && transport.site ? "site" + path : path;
  assert.ok(Object.hasOwn(responses, key), "Unexpected client route");
  return Promise.resolve(responses[key]);
};
(async function () {
  await api.login("fictional", "anything");
  assert.ok(api.getToken());
  await api.checkAuth();
  assert.equal((await api.getMyShows()).length, 5);
  assert.ok((await api.getAllShows()).length >= 150);
  assert.ok((await api.getMovies()).length >= 40);
  const episodes = api.normalizeEpisodes(await api.getEpisodes(1));
  assert.equal(episodes.length, 30);
  assert.ok(episodes[0].covers.small.endsWith(".svg"));
  const chosen = api.chooseRussianFile(episodes[0].files);
  assert.equal(chosen.quality, 4);
  assert.equal(api.chooseRussianFile(episodes.find(item => item.episode === 5).files), null);
  assert.equal((await api.getPlayback(1, chosen)).ok, 1);
  await api.markSeasonWatched(1, 1);
  await api.markShowWatched(1);
  await assert.rejects(api.getMoviePlayback(1), {code: "MOCK_NO_HLS"});
  assert.equal(parsedMovie, true);
}()).catch(() => { console.error("Mock API client compatibility failed"); process.exitCode = 1; });
'''
        result = subprocess.run(["node", "-e", script], cwd=ROOT, input=json.dumps(responses),
                                text=True, capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)


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
