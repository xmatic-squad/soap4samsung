#!/usr/bin/env python3
"""Loopback-only browser preview; production TV builds call Soap4me directly."""

import argparse
import http.cookiejar
import json
import mimetypes
from pathlib import Path
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
API = "https://api.soap4youand.me/v2"
SITE = "https://soap4youand.me"
GET_ROUTES = re.compile(r"/(?:auth/check|soap(?:/my)?|movies|episodes/\d+)/$")
POST_ROUTES = re.compile(r"/(?:auth|play/episode/\d+|episodes/watch/full/\d+(?:/\d+)?)/$")
SITE_GET_ROUTES = re.compile(r"/movies/\d+/$")
SITE_POST_ROUTES = re.compile(r"/login/$")


class Preview(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass  # Do not put account data or signed URLs in access logs.

    def reply(self, status, content, mime="application/json"):
        self.send_response(status)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(content)

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
        request = urllib.request.Request((SITE if is_site else API) + route, data=data, headers=headers, method=method)
        try:
            with self.server.api_opener.open(request, timeout=20) as response:
                body = response.read(16 * 1024 * 1024)
                self.reply(response.status, body, "text/html; charset=UTF-8" if is_site else "application/json")
        except urllib.error.HTTPError as exc:
            self.error(exc.code, "Soap4me request failed")
        except (OSError, urllib.error.URLError):
            self.error(502, "Soap4me unavailable")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Preview)
    # Preview login has its own in-memory cookies; no private session is loaded
    # from the filesystem and nothing is embedded in the application package.
    jar = http.cookiejar.CookieJar()
    server.api_opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    print(f"Preview: http://127.0.0.1:{args.port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
