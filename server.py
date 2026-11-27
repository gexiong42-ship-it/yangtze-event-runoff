"""Serve the desktop app and its local SQLite API on loopback only."""
import json
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from urllib.parse import parse_qs, urlsplit
import rasterio
from rasterio.enums import Resampling
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
        url = urlsplit(self.path)
        path = url.path
        if path == "/api/landuse":
            data = catalogue()
            rain = precipitation.metadata()
            data["precipitation"] = {key: value for key, value in rain.items() if key not in ("latitudes", "longitudes")} if rain else None
            self.send_json(200, data)
        elif path == "/api/land-use-preview":
            self.send_land_use_preview(parse_qs(url.query))
        elif path in ("/", "/index.html", "/style.css", "/app.js", "/runoff.js", "/result-view.js"):
            super().do_GET()
        else:
            self.send_error(404)

    def send_land_use_preview(self, query):
        basin = query.get("basin", [""])[0]
        year = query.get("year", [""])[0]
        layer = next((row for row in catalogue()["layers"]
                      if row["basin"] == basin and str(row["year"]) == year), None)
        if layer is None:
            self.send_json(404, {"error": "该流域与年份的土地利用图不存在。"})
            return
        try:
            with rasterio.open(ROOT / layer["path"]) as raster:
                scale = min(1, 960 / max(raster.width, raster.height))
                width = max(1, round(raster.width * scale))
                height = max(1, round(raster.height * scale))
                pixels = raster.read(1, out_shape=(height, width), resampling=Resampling.nearest,
                                     masked=True).filled(0).astype("uint8").tobytes()
        except (OSError, ValueError) as error:
            self.send_json(500, {"error": "土地利用图读取失败。"})
            self.log_error("Land use preview failed: %s", error)
            return
        self.send_response(200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Length", str(len(pixels)))
        self.send_header("X-Raster-Width", str(width))
        self.send_header("X-Raster-Height", str(height))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(pixels)

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
