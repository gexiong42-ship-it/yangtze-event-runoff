"""Area weights on the native CLCD equal-area grid, cached by file version."""
import hashlib
import json
from collections import Counter
from contextlib import ExitStack
import database
import precipitation
import numpy as np
import rasterio
from rasterio.io import MemoryFile
from rasterio.transform import from_origin
from rasterio.vrt import WarpedVRT
from rasterio.windows import Window
from rasterio.enums import Resampling

WARP_TOLERANCE = 1e-7


def weights(basin, year):
    info = precipitation.metadata()
    if not info:
        raise ValueError("尚未导入降水。")
    with database.connect() as connection:
        land = connection.execute("SELECT * FROM rasters WHERE basin=? AND year=?", (basin, year)).fetchone()
        soil = connection.execute("SELECT * FROM soil_rasters WHERE basin=?", (basin,)).fetchone()
        connection.execute("CREATE TABLE IF NOT EXISTS spatial_weights (basin TEXT,year INTEGER,signature TEXT,payload TEXT,"
                           "PRIMARY KEY(basin,year))")
        cached = connection.execute("SELECT signature,payload FROM spatial_weights WHERE basin=? AND year=?", (basin, year)).fetchone()
    if not land:
        raise ValueError("缺少 {} 年土地利用。".format(year))
    if not soil:
        raise ValueError("缺少土壤图层。")
    versions = []
    for layer in (land, soil):
        stat = (database.ROOT / layer["path"]).stat()
        if stat.st_size != layer["size_bytes"] or stat.st_mtime_ns != layer["modified_ns"]:
            raise ValueError("图层文件已变化，请重建资料索引。")
        versions.append([layer["path"], stat.st_size, stat.st_mtime_ns])
    signature = hashlib.sha256(json.dumps([3, WARP_TOLERANCE, versions, info["latitudes"], info["longitudes"]]).encode()).hexdigest()
    if cached and cached["signature"] == signature:
        return json.loads(cached["payload"])
    latitudes, longitudes = info["latitudes"], info["longitudes"]
    shape = len(latitudes), len(longitudes)
    cells = np.arange(1, shape[0] * shape[1] + 1, dtype="int32").reshape(shape)[::-1]
    counts = Counter()
    with ExitStack() as stack:
        land_dataset = stack.enter_context(rasterio.open(database.ROOT / land["path"]))
        soil_dataset = stack.enter_context(rasterio.open(database.ROOT / soil["path"]))
        if land_dataset.crs.to_dict().get("proj") != "aea":
            raise ValueError("当前面积统计要求 CLCD 使用 Albers 等积投影。")
        unit_factor = land_dataset.crs.linear_units_factor[1]
        affine = land_dataset.transform
        pixel_area = abs(affine.a * affine.e - affine.b * affine.d) * unit_factor ** 2 / 1e6
        memory = stack.enter_context(MemoryFile())
        with memory.open(driver="GTiff", height=shape[0], width=shape[1],
                         count=1, dtype="int32", crs="EPSG:4326", nodata=0,
                         transform=from_origin(longitudes[0] - .125, latitudes[-1] + .125, .25, .25)) as writer:
            writer.write(cells, 1)
        rain_grid = stack.enter_context(memory.open())
        options = dict(crs=land_dataset.crs, transform=affine, width=land_dataset.width,
                       height=land_dataset.height, resampling=Resampling.nearest, tolerance=WARP_TOLERANCE)
        soil_vrt = stack.enter_context(WarpedVRT(soil_dataset, **options, nodata=255))
        rain_vrt = stack.enter_context(WarpedVRT(rain_grid, **options, nodata=0))
        for row in range(0, land_dataset.height, 512):
            for col in range(0, land_dataset.width, 512):
                window = Window(col, row, min(512, land_dataset.width - col), min(512, land_dataset.height - row))
                classes = land_dataset.read(1, window=window, masked=True)
                valid = (~np.ma.getmaskarray(classes)) & (classes.data >= 1) & (classes.data <= 9)
                if not np.any(valid):
                    continue
                soils = soil_vrt.read(1, window=window).astype("int64")
                grids = rain_vrt.read(1, window=window).astype("int64") - 1
                codes = grids[valid] * 10000 + classes.data[valid].astype("int64") * 1000 + soils[valid]
                keys, quantities = np.unique(codes, return_counts=True)
                counts.update({int(key): int(quantity) for key, quantity in zip(keys, quantities)})
    groups = [{"grid": key // 10000, "landCode": (key % 10000) // 1000, "soilCode": key % 1000,
               "pixels": quantity, "areaKm2": quantity * pixel_area} for key, quantity in sorted(counts.items())]
    result = {"basin": basin, "year": year, "signature": signature, "landRaster": land["path"], "soilRaster": soil["path"],
              "totalAreaKm2": sum(group["areaKm2"] for group in groups), "pixelAreaKm2": pixel_area,
              "method": "原生 CLCD 像元中心分配 CN05.1 网格及最近邻 HYSOGs 土组，按等积像元面积统计", "groups": groups}
    with database.connect() as connection:
        connection.execute("INSERT OR REPLACE INTO spatial_weights VALUES (?,?,?,?)",
                           (basin, year, signature, json.dumps(result, ensure_ascii=False)))
    return result
