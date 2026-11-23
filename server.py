"""Serve the desktop app and its local SQLite API on loopback only."""
import json
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from urllib.parse import urlsplit
from database import ROOT, catalogue, prepare, save_parameters, DB, build, build_soils
import precipitation
from event_input import assemble


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def send_json(self, status, data):
        content = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(content)

    def do_GET(self):
        path = urlsplit(self.path).path
        if path == "/api/landuse":
            data = catalogue()
            rain = precipitation.metadata()
            data["precipitation"] = {key: value for key, value in rain.items() if key not in ("latitudes", "longitudes")} if rain else None
            self.send_json(200, data)
        elif path in ("/", "/index.html", "/style.css", "/app.js", "/runoff.js"):
            super().do_GET()
        else:
            self.send_error(404)

    def do_POST(self):
        try:
            if self.headers.get("Origin") not in (None, "http://" + self.headers.get("Host", "")):
                raise ValueError("请求来源无效。")
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 20 * 1024 * 1024:
                raise ValueError("请求大小无效或超过 20 MB。")
            data = json.loads(self.rfile.read(length).decode("utf-8"))
            if self.path == "/api/event-input":
                if not isinstance(data, dict):
                    raise ValueError("请求内容应为对象。")
                self.send_json(200, assemble(data))
            elif self.path == "/api/prepare":
                if not isinstance(data, dict):
                    raise ValueError("请求内容应为对象。")
                self.send_json(200, prepare(data["input"], int(data["year"]),
                                           data.get("drainage", "undrained"), data.get("drainageSource", ""),
                                           data.get("allowIncomplete") is True))
            elif self.path == "/api/cn":
                self.send_json(200, save_parameters(data))
            else:
                self.send_error(404)
        except (ValueError, KeyError, TypeError, OSError) as error:
            self.send_json(400, {"error": str(error)})


if __name__ == "__main__":
    if not DB.exists():
        build()
    if not catalogue()["soilLayers"]:
        build_soils()
    print("打开 http://127.0.0.1:8765", flush=True)
    ThreadingHTTPServer(("127.0.0.1", 8765), Handler).serve_forever()
