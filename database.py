"""Local raster catalogue and spatial lookup. Original rasters remain in place."""
import copy
import json
import re
import sqlite3
import sys
from contextlib import contextmanager
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / ".runtime"))
import rasterio
import numpy as np
from rasterio.warp import transform

DB = ROOT / "data" / "landuse.sqlite3"
SOIL_SOURCE = "https://doi.org/10.1038/sdata.2018.91"
SOIL_GROUPS = {1: "A", 2: "B", 3: "C", 4: "D", 11: "A/D", 12: "B/D", 13: "C/D", 14: "D/D"}
TAIHU_ID = "太湖流域及苏南河网"
TAIHU_NAME = "太湖流域（八区外缘试用边界）"
TAIHU_NOTE = "边界据太浦河后续（一期）工程环境影响报告书图4.1-1配准并概化描绘，按提供的八区外缘试用边界计算。"


def taihu_release():
    path = ROOT / "data/taihu_trial/active.json"
    return json.loads(path.read_text("utf-8")) if path.exists() else {}


@contextmanager
def connect():
    DB.parent.mkdir(exist_ok=True)
    connection = sqlite3.connect(str(DB))
    connection.row_factory = sqlite3.Row
    connection.executescript("""
        CREATE TABLE IF NOT EXISTS rasters (
          year INTEGER NOT NULL, basin TEXT NOT NULL, path TEXT NOT NULL UNIQUE,
          crs TEXT NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL,
          nodata REAL, bounds TEXT NOT NULL, transform_json TEXT NOT NULL,
          size_bytes INTEGER NOT NULL, modified_ns INTEGER NOT NULL,
          PRIMARY KEY(year, basin));
        CREATE TABLE IF NOT EXISTS cn_parameters (
          land_code INTEGER NOT NULL CHECK(land_code BETWEEN 1 AND 9),
          soil TEXT NOT NULL CHECK(soil IN ('A','B','C','D')),
          cn REAL NOT NULL CHECK(cn > 0 AND cn <= 100),
          source TEXT NOT NULL, conditions TEXT NOT NULL,
          PRIMARY KEY(land_code, soil));
        CREATE TABLE IF NOT EXISTS soil_rasters (
          basin TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, crs TEXT NOT NULL,
          width INTEGER NOT NULL, height INTEGER NOT NULL, nodata REAL,
          bounds TEXT NOT NULL, transform_json TEXT NOT NULL,
          size_bytes INTEGER NOT NULL, modified_ns INTEGER NOT NULL,
          codes_json TEXT NOT NULL, source TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS tr55_reference (
          id TEXT PRIMARY KEY, table_id TEXT NOT NULL, profile_json TEXT NOT NULL,
          snapshot_sha256 TEXT NOT NULL, retrieved_utc TEXT NOT NULL);
    """)
    try:
        with connection:
            yield connection
    finally:
        connection.close()


def build():
    paths = sorted((ROOT / "CLCD核心研究区裁剪成果").rglob("*.tif"))
    release = taihu_release()
    if release:
        paths = [path for path in paths if not path.name.startswith("05_" + TAIHU_ID + "_CLCD_")]
        paths.extend(ROOT / path for path in release["land"])
    if not paths:
        raise ValueError("未找到土地利用 GeoTIFF。")
    records = []
    for path in paths:
        match = re.fullmatch(r"\d+_(.+)_CLCD_(\d{4})", path.stem)
        if not match:
            raise ValueError("无法识别文件年份及流域 " + path.name)
        with rasterio.open(path) as dataset:
            if not dataset.crs or dataset.count != 1:
                raise ValueError("坐标系或波段无效 " + path.name)
            stat = path.stat()
            records.append((int(match[2]), match[1], path.relative_to(ROOT).as_posix(),
                            dataset.crs.to_string(), dataset.width, dataset.height,
                            dataset.nodata, json.dumps(list(dataset.bounds)),
                            json.dumps(list(dataset.transform)), stat.st_size, stat.st_mtime_ns))
    with connect() as connection:
        connection.execute("DELETE FROM rasters")
        connection.executemany("INSERT INTO rasters VALUES (?,?,?,?,?,?,?,?,?,?,?)", records)
    return {"files": len(records), "years": sorted(set(row[0] for row in records))}


def catalogue():
    with connect() as connection:
        layers = [dict(row) for row in connection.execute(
            "SELECT year,basin,path,crs,width,height,nodata FROM rasters ORDER BY year,basin")]
        count = connection.execute("SELECT COUNT(*) FROM cn_parameters").fetchone()[0]
        parameters = [dict(row) for row in connection.execute("SELECT * FROM cn_parameters ORDER BY land_code,soil")]
        references = [json.loads(row[0]) for row in connection.execute("SELECT profile_json FROM tr55_reference ORDER BY table_id,id")]
        soils = [dict(row) for row in connection.execute(
            "SELECT basin,path,crs,width,height,nodata,codes_json,source FROM soil_rasters ORDER BY basin")]
    for row in soils:
        row["codes"] = json.loads(row.pop("codes_json"))
    return {"years": sorted(set(row["year"] for row in layers)), "layers": layers,
            "cnParameterCount": count, "soilLayers": soils, "cnParameters": parameters, "tr55References": references,
            "regionNotes": region_notes(), "displayNames": {TAIHU_ID: TAIHU_NAME} if taihu_release() else {}}


def region_notes():
    if taihu_release():
        return {TAIHU_ID: TAIHU_NOTE}
    path = ROOT / "data" / "audit2021" / "audit.json"
    if not path.exists():
        return {}
    audit = json.loads(path.read_text("utf-8"))
    return {region["basin"]: "原始资料采用经纬度展示矩形，包含沿海范围，不能按闭合水文流域解释；面积与覆盖率以 CLCD 有效分类范围为基准。"
            for region in audit["regions"] if region["boundaryKind"] == "经纬度展示矩形"}


def coverage_reference(basin, year):
    if basin == TAIHU_ID and taihu_release():
        return taihu_release()["coverage"].get(str(year), {})
    annual = ROOT / 'cloud' / 'src' / 'annual-coverage.json'
    if annual.exists():
        reference = json.loads(annual.read_text('utf-8')).get('years', {}).get(str(year), {}).get(basin)
        if reference is not None:
            return reference
    path = ROOT / "data" / "audit2021" / "audit.json"
    if year != 2021 or not path.exists():
        return {}
    audit = json.loads(path.read_text("utf-8"))
    return next((region for region in audit["regions"] if region["basin"] == basin), {})


def build_soils():
    buffered = ROOT / "data" / "HYSOGs250m_buffered"
    folder = buffered if (buffered / "manifest.json").exists() else ROOT / "data" / "HYSOGs250m"
    paths = sorted(folder.glob("*.tif"))
    release = taihu_release()
    if release:
        paths = [path for path in paths if path.name != "05_" + TAIHU_ID + "_HYSOGs250m.tif"]
        paths.append(ROOT / release["soil"])
    if not paths:
        raise ValueError("未找到 HYSOGs250m GeoTIFF。")
    records = []
    for path in paths:
        match = re.fullmatch(r"\d+_(.+)_HYSOGs250m", path.stem)
        if not match:
            raise ValueError("无法识别土壤流域 " + path.name)
        with rasterio.open(path) as dataset:
            if not dataset.crs or dataset.count != 1:
                raise ValueError("土壤坐标系或波段无效 " + path.name)
            values, counts = np.unique(dataset.read(1, masked=True).compressed(), return_counts=True)
            codes = {int(code): int(count) for code, count in zip(values, counts)}
            if not set(codes).issubset(SOIL_GROUPS):
                raise ValueError("发现未知 HYSOGs 编码 " + path.name)
            stat = path.stat()
            records.append((match[1], path.relative_to(ROOT).as_posix(), dataset.crs.to_string(),
                            dataset.width, dataset.height, dataset.nodata, json.dumps(list(dataset.bounds)),
                            json.dumps(list(dataset.transform)), stat.st_size, stat.st_mtime_ns,
                            json.dumps(codes), SOIL_SOURCE))
    with connect() as connection:
        connection.execute("DELETE FROM soil_rasters")
        connection.executemany("INSERT INTO soil_rasters VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", records)
    return {"soilFiles": len(records)}


def read_soil(layer, longitude, latitude, drainage):
    if drainage not in ("undrained", "drained"):
        raise ValueError("双重土组处理须选择未充分排水或充分排水。")
    path = ROOT / layer["path"]
    stat = path.stat()
    if stat.st_size != layer["size_bytes"] or stat.st_mtime_ns != layer["modified_ns"]:
        raise ValueError("土壤文件已变化，请重新建立土壤索引。")
    with rasterio.open(path) as dataset:
        x, y = transform("EPSG:4326", dataset.crs, [longitude], [latitude])
        row, col = dataset.index(x[0], y[0])
        if not (0 <= row < dataset.height and 0 <= col < dataset.width):
            raise ValueError("单元超出土壤图层范围。")
        pixel = next(dataset.sample([(x[0], y[0])], masked=True))[0]
        if getattr(pixel, "mask", False) or int(pixel) not in SOIL_GROUPS:
            raise ValueError("单元位于土壤缺测或未知编码像元。")
        code = int(pixel)
    original = SOIL_GROUPS[code]
    group = original
    if code >= 11:
        group = original.split("/")[0] if drainage == "drained" else "D"
    return code, original, group


def save_parameters(rows):
    if not isinstance(rows, list) or not rows:
        raise ValueError("参数文件应为非空数组。")
    values = []
    seen = set()
    for row in rows:
        if not isinstance(row, dict):
            raise ValueError("参数表每行应为对象。")
        code, soil, cn = row.get("landCode"), row.get("soil"), row.get("cn")
        source, conditions = row.get("source"), row.get("conditions")
        if (type(code) is not int or code not in range(1, 10) or soil not in ("A", "B", "C", "D")
                or type(cn) not in (int, float) or not 0 < cn <= 100
                or not isinstance(source, str) or not source.strip()
                or not isinstance(conditions, str) or not conditions.strip()
                or (code, soil) in seen):
            raise ValueError("请提供唯一的地类/土组、有效 CN、出处和适用条件。")
        seen.add((code, soil))
        values.append((code, soil, cn, source.strip(), conditions.strip()))
    with connect() as connection:
        connection.executemany("INSERT OR REPLACE INTO cn_parameters VALUES (?,?,?,?,?)", values)
    return {"saved": len(values)}


def prepare(input_data, year, drainage="undrained", drainage_source="", allow_incomplete=False):
    if not isinstance(input_data, dict):
        raise ValueError("输入应为相交单元对象。")
    result = copy.deepcopy(input_data)
    if not isinstance(result.get("units"), list) or not result["units"]:
        raise ValueError("缺少相交单元。")
    if drainage not in ("undrained", "drained"):
        raise ValueError("双重土组处理选项无效。")
    if drainage == "drained" and (not isinstance(drainage_source, str) or not drainage_source.strip()):
        raise ValueError("采用充分排水土组时，请填写排水依据。")
    with connect() as connection:
        layers = {row["basin"]: dict(row) for row in connection.execute("SELECT * FROM rasters WHERE year=?", (year,))}
        parameters = {(row["land_code"], row["soil"]): dict(row)
                      for row in connection.execute("SELECT * FROM cn_parameters")}
        soils = {row["basin"]: dict(row) for row in connection.execute("SELECT * FROM soil_rasters")}
    if not layers:
        raise ValueError("数据库没有 {} 年土地利用，请选择已有年份的事件。".format(year))
    names = {1: "耕地", 2: "林地", 3: "灌木地", 4: "草地", 5: "水体", 6: "冰雪", 7: "裸地", 8: "不透水面", 9: "湿地"}
    sources = set()
    used_paths = set()
    soil_paths = set()
    missing_cn = []
    for unit in result["units"]:
        if not isinstance(unit, dict):
            raise ValueError("相交单元应为对象。")
        layer = layers.get(unit.get("basin"))
        if not layer:
            raise ValueError("流域名称须与数据库一致 " + str(unit.get("basin")))
        path = ROOT / layer["path"]
        stat = path.stat()
        if stat.st_size != layer["size_bytes"] or stat.st_mtime_ns != layer["modified_ns"]:
            raise ValueError("土地利用文件已变化，请重新建立索引。")
        longitude, latitude = unit.get("longitude"), unit.get("latitude")
        if (type(longitude) not in (int, float) or type(latitude) not in (int, float)
                or not -180 <= longitude <= 180 or not -90 <= latitude <= 90):
            raise ValueError("单元 {} 缺少有效 longitude/latitude（WGS84）。".format(unit.get("id")))
        with rasterio.open(path) as dataset:
            x, y = transform("EPSG:4326", dataset.crs, [longitude], [latitude])
            row, col = dataset.index(x[0], y[0])
            if not (0 <= row < dataset.height and 0 <= col < dataset.width):
                raise ValueError("单元 {} 超出所选流域。".format(unit.get("id")))
            pixel = next(dataset.sample([(x[0], y[0])], masked=True))[0]
            if getattr(pixel, "mask", False) or int(pixel) not in names:
                raise ValueError("单元 {} 位于缺测或未分类像元。".format(unit.get("id")))
            code = int(pixel)
        soil_layer = soils.get(unit.get("basin"))
        if not soil_layer:
            raise ValueError("该流域缺少 HYSOGs250m 土壤图层，请建立土壤索引。")
        soil_code, original_soil, soil = read_soil(soil_layer, longitude, latitude, drainage)
        unit.update(soil=soil, soilCode=soil_code, soilOriginal=original_soil,
                    soilRasterPath=soil_layer["path"], soilSource=soil_layer["source"])
        soil_paths.add(soil_layer["path"])
        parameter = parameters.get((code, soil))
        if not parameter:
            warning = "单元 {} 的地类 {} / 土组 {} 缺少 CN 参数".format(unit.get("id"), code, soil)
            if not allow_incomplete:
                raise ValueError(warning + "，请导入有出处的参数表。")
            missing_cn.append(warning)
        unit.update(landUse=names[code], landCode=code, referenceCN=parameter["cn"] if parameter else None,
                    cnSource=parameter["source"] if parameter else "", cnConditions=parameter["conditions"] if parameter else "",
                    landuseYear=year, rasterPath=layer["path"])
        if parameter:
            sources.add(parameter["source"])
        used_paths.add(layer["path"])
    result["layer"] = {"year": year, "version": "CLCD {} 核心研究区".format(year),
                       "cnSource": "；".join(sorted(sources)) or "待补充 CN 参数", "rasters": sorted(used_paths),
                       "lookup": "WGS84 单元代表点像元取值"}
    result["soilLayer"] = {"version": "HYSOGs250m 核心研究区", "rasters": sorted(soil_paths),
                           "source": SOIL_SOURCE, "drainage": drainage,
                           "drainageSource": drainage_source if drainage == "drained" else "未充分排水情景，双重土组采用 D",
                           "lookup": "WGS84 单元代表点像元取值"}
    result["missingCN"] = missing_cn
    return result


if __name__ == "__main__":
    print(json.dumps(build(), ensure_ascii=False))
    print(json.dumps(build_soils(), ensure_ascii=False))
