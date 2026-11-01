#!/usr/bin/env python3
"""Loopback-only browser preview; production TV builds call Soap4me directly."""

import argparse
import http.cookiejar
import json
import mimetypes
from pathlib import Path
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
API = "https://api.soap4youand.me/v2"
SITE = "https://soap4youand.me"
GET_ROUTES = re.compile(r"/(?:auth/check|soap(?:/my)?|movies|episodes/\d+)/$")
POST_ROUTES = re.compile(r"/(?:auth|play/episode/\d+|episodes/watch/full/\d+(?:/\d+)?)/$")
SITE_GET_ROUTES = re.compile(r"/movies/\d+/$")
SITE_POST_ROUTES = re.compile(r"/login/$")


class MockData:
    """Deterministic, fictional data belonging to one preview server."""

    def __init__(self, port):
        self.base = f"http://127.0.0.1:{port}/mock"
        self.lock = threading.Lock()
        self.shows = []
        self.episodes = {}
        self.files = set()
        for sid in range(1, 161):
            episodes = []
            for season, numbers in ((1, range(1, 7)), (2, (1, 2, 4, 5)), (3, range(1, 21))):
                for number in numbers:
                    files = []
                    for quality in range(1, 5):
                        eid = sid * 100000 + season * 1000 + number * 10 + quality
                        files.append({"eid": eid, "hash": f"mock-{eid}", "quality": quality,
                                      "translate": 1 if number % 5 == 0 else 4})
                        self.files.add(eid)
                    episodes.append({"season": season, "episode": number,
                                     "title": f"Imaginary Signal {number:02d}",
                                     "title_ru": f"Вымышленный сигнал {number:02d}",
                                     "watched": int(sid % 5 == 0 or (season == 1 and number <= sid % 4)),
                                     "files": files})
            # Season 2 deliberately has neither episode 3 nor its own cover.
            self.episodes[sid] = {"episodes": episodes, "covers": [
                dict(season=season, **self.cover(sid * 10 + season)) for season in (1, 3)
            ]}
            show = {"sid": sid, "title": f"Imaginary Orbit {sid:03d}",
                    "title_ru": f"Вымышленная орбита {sid:03d}",
                    "title_original": f"Imaginary Orbit {sid:03d}",
                    "description": f"Вымышленный сериал №{sid}: экспедиция ищет сигналы на бумажной планете.",
                    "year": str(2000 + sid % 27), "watching": int(sid <= 5),
                    "unwatched": sum(not episode["watched"] for episode in episodes)}
            if sid % 7:
                show["covers"] = self.cover(sid)
            if sid % 6:
                show.update(self.ratings(sid, strings=True))
            self.shows.append(show)
        self.movies = []
        for mid in range(1, 49):
            movie = {"id": mid, "title": f"Paper Comet {mid:03d}",
                     "title_ru": f"Бумажная комета {mid:03d}",
                     "title_original": f"Paper Comet {mid:03d}", "year": str(2000 + mid % 27),
                     "description": "Вымышленный фильм о путешествии по нарисованной галактике.",
                     "runtime": 80 + mid % 50, "watched": int(mid % 4 == 0)}
            if mid % 7:
                movie["covers"] = self.cover(10000 + mid)
            if mid % 6:
                movie.update(self.ratings(mid, strings=False))
            self.movies.append(movie)

    def cover(self, identifier):
        url = f"{self.base}/cover/{identifier}.svg"
        return {"small": url, "big": url}

    @staticmethod
    def ratings(identifier, strings):
        values = [round(4 + (identifier * factor % 60) / 10, 1) for factor in (7, 11, 13)]
        return dict(zip(("imdb_rating", "kinopoisk_rating", "soap_rating"),
                        [f"{value:.1f}" for value in values] if strings else values))

    def mark_watched(self, sid, season):
        detail = self.episodes.get(sid)
        if detail is None or (season is not None and not any(
                item["season"] == season for item in detail["episodes"])):
            return False
        for episode in detail["episodes"]:
            if season is None or episode["season"] == season:
                episode["watched"] = 1
        self.shows[sid - 1]["unwatched"] = sum(not item["watched"] for item in detail["episodes"])
        return True


class Preview(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass  # Do not put account data or signed URLs in access logs.

    def content_headers(self, status, length, mime, headers=None):
        self.send_response(status)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(length))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        if self.server.mock_data is not None:
            # The real movie parser accepts only CDN URLs. Block its subsequent
            # manifest XHR (and any stale external media) before it leaves the browser.
            self.send_header("Content-Security-Policy", "connect-src 'self'; media-src 'self'; img-src 'self' data:")
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.end_headers()

    def reply(self, status, content, mime="application/json", headers=None):
        self.content_headers(status, len(content), mime, headers)
        self.wfile.write(content)

    def json_reply(self, content):
        self.reply(200, json.dumps(content, ensure_ascii=False).encode("utf-8"))

    def error(self, status, message):
        self.reply(status, json.dumps({"error": message}).encode())

    def trusted_request(self):
        expected = f"127.0.0.1:{self.server.server_port}"
        return self.headers.get("Host") == expected and self.headers.get("Origin") in (
            None, f"http://{expected}"
        )

    def do_GET(self):
        if not self.trusted_request():
            return self.error(403, "Local preview only")
        if self.path.startswith(("/api/v2/", "/site/")):
            return self.proxy("GET")
        if self.server.mock_data is not None and self.path.startswith("/mock/"):
            self.mock_delay()
            return self.mock_asset()
        if self.path == "/config.local.js":
            config = {"apiBase": "/api/v2", "siteBase": "/site", "version": json.loads((ROOT / "package.json").read_text())["version"]}
            return self.reply(200, ("window.SOAP_CONFIG=" + json.dumps(config) + ";").encode(), "text/javascript")
        path = self.path.split("?", 1)[0]
        if path == "/":
            path = "/index.html"
        target = (ROOT / "app" / path.lstrip("/")).resolve()
        if not target.is_relative_to((ROOT / "app").resolve()) or not target.is_file():
            return self.error(404, "Not found")
        self.reply(200, target.read_bytes(), mimetypes.guess_type(str(target))[0] or "application/octet-stream")

    def do_POST(self):
        if not self.trusted_request():
            return self.error(403, "Local preview only")
        self.proxy("POST")

    def proxy(self, method):
        is_site = self.path.startswith("/site/")
        prefix = "/site" if is_site else "/api/v2"
        route = self.path.removeprefix(prefix)
        if is_site:
            allowed = SITE_GET_ROUTES if method == "GET" else SITE_POST_ROUTES
        else:
            allowed = GET_ROUTES if method == "GET" else POST_ROUTES
        if not self.path.startswith(prefix + "/") or not allowed.fullmatch(route):
            return self.error(404, "Unsupported preview endpoint")
        headers = {"User-Agent": "Soap4Samsung/0.3", "Accept": "*/*" if is_site else "application/json"}
        token = self.headers.get("X-API-TOKEN")
        if token and not is_site:
            headers["X-API-TOKEN"] = token
        data = None
        if method == "POST":
            try:
                length = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                return self.error(400, "Invalid request size")
            if not 0 <= length <= 16384:
                return self.error(413, "Request too large")
            data = self.rfile.read(length)
            headers["Content-Type"] = "application/x-www-form-urlencoded"
        if self.server.mock_data is not None:
            self.mock_delay()
            return self.mock_response(method, route, is_site, data)
        request = urllib.request.Request((SITE if is_site else API) + route, data=data, headers=headers, method=method)
        try:
            with self.server.api_opener.open(request, timeout=20) as response:
                body = response.read(16 * 1024 * 1024)
                self.reply(response.status, body, "text/html; charset=UTF-8" if is_site else "application/json")
        except urllib.error.HTTPError as exc:
            self.error(exc.code, "Soap4me request failed")
        except (OSError, urllib.error.URLError):
            self.error(502, "Soap4me unavailable")

    def mock_delay(self):
        if self.server.mock_delay_ms:
            time.sleep(self.server.mock_delay_ms / 1000)

    def mock_response(self, method, route, is_site, data):
        mock = self.server.mock_data
        if method == "POST" and route in ("/auth/", "/login/"):
            form = urllib.parse.parse_qs(data.decode("utf-8", errors="replace"))
            if not form.get("login", [""])[0].strip() or not form.get("password", [""])[0]:
                return self.error(401, "Enter a nonempty mock login and password")
            if is_site:
                return self.reply(200, b'<html><body><form action="/logout/"></form></body></html>', "text/html; charset=UTF-8")
            return self.json_reply({"ok": 1, "token": "synthetic-preview-session"})
        with mock.lock:
            if is_site:
                mid = int(route.split("/")[2])
                if not 1 <= mid <= len(mock.movies):
                    return self.error(404, "Unknown mock movie")
                # Fictional unsigned URL satisfying parseMoviePlayer's allowlist.
                # No manifest is served; the mock page's CSP forbids CDN requests.
                stream = f"https://cdn-mock.soap4youand.me/hls/mock-{mid}/master.m3u8"
                title = json.dumps(mock.movies[mid - 1]["title_ru"], ensure_ascii=False)
                html = ('<html><body><form action="/logout/"></form><script>'
                        f'cache["movie_player_{mid}"] = new Playerjs({{file: {json.dumps(stream)}, title: {title}}});'
                        '</script></body></html>')
                return self.reply(200, html.encode("utf-8"), "text/html; charset=UTF-8")
            if route == "/auth/check/":
                return self.json_reply({"logged": 1, "loged": 1})
            if route in ("/soap/", "/soap/my/"):
                return self.json_reply(mock.shows if route == "/soap/" else mock.shows[:5])
            if route == "/movies/":
                return self.json_reply(mock.movies)
            match = re.fullmatch(r"/episodes/(\d+)/", route)
            if match:
                detail = mock.episodes.get(int(match[1]))
                if detail is None:
                    return self.error(404, "Unknown mock show")
                return self.json_reply(detail)
            match = re.fullmatch(r"/play/episode/(\d+)/", route)
            if match:
                if int(match[1]) not in mock.files:
                    return self.error(404, "Unknown mock episode file")
                return self.json_reply({"ok": 1, "stream": mock.base + "/sample", "start_from": 0})
            match = re.fullmatch(r"/episodes/watch/full/(\d+)(?:/(\d+))?/", route)
            if match and mock.mark_watched(int(match[1]), int(match[2]) if match[2] else None):
                return self.json_reply({"ok": 1})
            return self.error(404, "Unknown mock show or season")

    def mock_asset(self):
        match = re.fullmatch(r"/mock/cover/(\d+)\.svg", self.path)
        if match:
            identifier = int(match[1])
            hue = identifier * 47 % 360
            svg = ('<svg xmlns="http://www.w3.org/2000/svg" width="480" height="480" viewBox="0 0 480 480">'
                   f'<rect width="480" height="480" fill="hsl({hue},45%,25%)"/>'
                   f'<circle cx="240" cy="190" r="110" fill="hsl({hue},60%,45%)"/>'
                   '<text x="240" y="370" text-anchor="middle" fill="white" font-family="sans-serif" font-size="32">'
                   f'MOCK {identifier}</text></svg>')
            return self.reply(200, svg.encode(), "image/svg+xml")
        if self.path != "/mock/sample" or self.server.sample_video is None:
            return self.error(404, "No mock sample video")
        try:
            sample = self.server.sample_video.open("rb")
        except OSError:
            return self.error(404, "No mock sample video")
        with sample:
            sample.seek(0, 2)
            size = sample.tell()
            start, end = 0, size - 1
            headers = {"Accept-Ranges": "bytes"}
            status = 200
            value = self.headers.get("Range")
            if value is not None:
                match = re.fullmatch(r"bytes=(\d*)-(\d*)", value)
                try:
                    if not match or not any(match.groups()) or not size:
                        raise ValueError()
                    first, last = match.groups()
                    if first:
                        start = int(first)
                        end = min(int(last), size - 1) if last else size - 1
                    else:
                        suffix = int(last)
                        if suffix == 0:
                            raise ValueError()
                        start = max(0, size - suffix)
                    if start >= size or end < start:
                        raise ValueError()
                except ValueError:
                    headers["Content-Range"] = f"bytes */{size}"
                    return self.reply(416, b"", "application/octet-stream", headers)
                status = 206
                headers["Content-Range"] = f"bytes {start}-{end}/{size}"
            length = max(0, end - start + 1)
            mime = mimetypes.guess_type(str(self.server.sample_video))[0] or "application/octet-stream"
            self.content_headers(status, length, mime, headers)
            sample.seek(start)
            try:
                while length:
                    chunk = sample.read(min(length, 64 * 1024))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    length -= len(chunk)
            except (BrokenPipeError, ConnectionResetError):
                pass  # HTML5 video can cancel an earlier range when seeking.


def create_server(port=8765, mock=False, sample_video=None, mock_delay_ms=0):
    if mock_delay_ms < 0:
        raise ValueError("--mock-delay-ms must be nonnegative")
    if not mock and (sample_video is not None or mock_delay_ms):
        raise ValueError("--sample-video and --mock-delay-ms require --mock")
    sample = Path(sample_video).expanduser().resolve() if sample_video is not None else None
    if sample is not None and not sample.is_file():
        raise ValueError("--sample-video must name an existing file")
    server = ThreadingHTTPServer(("127.0.0.1", port), Preview)
    server.mock_data = MockData(server.server_port) if mock else None
    server.sample_video = sample
    server.mock_delay_ms = mock_delay_ms
    if not mock:
        # No private session is loaded from disk or embedded in the package.
        jar = http.cookiejar.CookieJar()
        server.api_opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    return server


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--mock", action="store_true", help="Use fictional offline data instead of Soap4me")
    parser.add_argument("--sample-video", type=Path, help="Local browser-compatible video for mock episode playback")
    parser.add_argument("--mock-delay-ms", type=int, default=0, help="Delay each mock API/asset response by N milliseconds")
    args = parser.parse_args()
    try:
        server = create_server(args.port, args.mock, args.sample_video, args.mock_delay_ms)
    except ValueError as exc:
        parser.error(str(exc))
    print(f"Preview{' (mock)' if args.mock else ''}: http://127.0.0.1:{server.server_port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
