"""Assemble all data required to calculate an event directly from local stores."""
from datetime import date, timedelta
from collections import defaultdict
import math
import database
import precipitation
import spatial
import numpy as np

MOISTURE_SOURCE = "https://www.in.gov/dot/div/contracts/standards/dm-Archived/10Metric/Part4/Ch29/figures/Fig29-10G.pdf"
LAND_NAMES = {1: "耕地", 2: "林地", 3: "灌木地", 4: "草地", 5: "水体", 6: "冰雪", 7: "裸地", 8: "不透水面", 9: "湿地"}


def period(config):
    event = precipitation.day_range(config["start"], config["end"])
    first = date.fromisoformat(config["start"])
    antecedent = precipitation.day_range(config.get("antecedentStart", (first - timedelta(days=5)).isoformat()),
                                         config.get("antecedentEnd", (first - timedelta(days=1)).isoformat()))
    if antecedent[-1] >= event[0]:
        raise ValueError("湿润度计算日期须早于事件开始日期。")
    scheme = config.get("moistureScheme", "growing")
    if scheme in ("growing", "dormant"):
        if len(antecedent) != 5 or antecedent[-1] != (first - timedelta(days=1)).isoformat():
            raise ValueError("传统前期湿润分级要求事件前连续五天。其他时段请选择自定义判据并提供阈值与出处。")
        low, high = (36, 53) if scheme == "growing" else (13, 28)
        moisture = {"dryBelow": low, "wetFrom": high, "wetInclusive": False,
                    "season": "生长期" if scheme == "growing" else "休眠期",
                    "source": "传统五日前期降水分级；" + MOISTURE_SOURCE}
    elif scheme == "custom":
        low, high = config.get("dryBelow"), config.get("wetFrom")
        source = config.get("moistureSource", "")
        if (type(low) not in (int, float) or type(high) not in (int, float)
                or not math.isfinite(low) or not math.isfinite(high) or not 0 <= low < high
                or not isinstance(source, str) or not source.strip()):
            raise ValueError("自定义湿润判据须提供有效阈值和出处。")
        moisture = {"dryBelow": low, "wetFrom": high, "wetInclusive": False,
                    "season": "自定义前期时段", "source": source}
    else:
        raise ValueError("湿润判据无效。")
    return {"event": event, "antecedent": antecedent}, moisture


def assemble(config):
    dates, moisture = period(config)
    basin = config["basin"]
    year = date.fromisoformat(config["start"]).year
    drainage = config.get("drainage", "undrained")
    drainage_source = config.get("drainageSource", "")
    if drainage not in ("undrained", "drained"):
        raise ValueError("排水情景无效。")
    if drainage == "drained" and not str(drainage_source).strip():
        raise ValueError("请选择排水情景并填写充分排水依据。")
    info, fields = precipitation.read_days(dates["antecedent"] + dates["event"])
    area = spatial.weights(basin, year)
    with database.connect() as connection:
        parameters = {(row["land_code"], row["soil"]): dict(row) for row in connection.execute("SELECT * FROM cn_parameters")}
    paved_rows = [parameters.get((8, soil)) for soil in "ABCD"]
    paved_parameter = None
    if all(paved_rows) and len({row["cn"] for row in paved_rows}) == 1:
        paved_parameter = {"cn": paved_rows[0]["cn"],
                           "source": "；".join(sorted({row["source"] for row in paved_rows})),
                           "conditions": "；".join(sorted({row["conditions"] for row in paved_rows})) + "；A/B/C/D 四土组 CN 一致，不透水面无需土组判定"}
    units, water = [], []
    excluded = defaultdict(float)
    total_rain = 0.0
    rain_area = 0.0
    water_area = 0.0
    soil_independent_area = 0.0
    all_days = dates["antecedent"] + dates["event"]
    for index, group in enumerate(area["groups"]):
        grid, code, soil_code, km2 = group["grid"], group["landCode"], group["soilCode"], group["areaKm2"]
        needed_days = dates["event"] if code == 5 else all_days
        if grid < 0 or any(not np.isfinite(fields[day][grid]) for day in needed_days):
            excluded["降水缺测"] += km2
            continue
        rain = {day: float(fields[day][grid]) for day in needed_days}
        event_mm = sum(rain[day] for day in dates["event"])
        total_rain += km2 * event_mm
        rain_area += km2
        if code == 5:
            water_area += km2
            water.append({"grid": grid, "areaKm2": km2, "rain": rain, "volumeM3": km2 * event_mm * 1000})
            continue
        original = database.SOIL_GROUPS.get(soil_code)
        if not original:
            if code != 8 or paved_parameter is None:
                excluded["土组缺测"] += km2
                continue
            soil = "不适用"
            parameter = paved_parameter
            soil_independent_area += km2
        else:
            soil = original.split("/")[0] if drainage == "drained" else original.split("/")[-1]
            parameter = parameters.get((code, soil))
        if not parameter:
            excluded["{} / {} 缺少 CN".format(LAND_NAMES[code], soil)] += km2
            continue
        units.append({"id": basin + "-" + str(index), "basin": basin, "grid": grid, "landCode": code,
                      "landUse": LAND_NAMES[code], "soilCode": soil_code, "soilOriginal": original or "原始 NoData", "soil": soil,
                      "areaKm2": km2, "rain": rain, "referenceCN": parameter["cn"],
                      "cnSource": parameter["source"], "cnConditions": parameter["conditions"]})
    if not units:
        raise ValueError("所选区域没有同时具备降水、土组与 CN 的有效陆地单元。")
    quality = {"basin": basin, "totalAreaKm2": area["totalAreaKm2"], "landAreaKm2": sum(u["areaKm2"] for u in units),
               "waterAreaKm2": water_area, "waterVolumeM3": sum(u["volumeM3"] for u in water),
               "excluded": dict(excluded), "excludedAreaKm2": sum(excluded.values()),
               "rainMm": total_rain / rain_area if rain_area else None,
               "spatialMethod": area["method"], "spatialSignature": area["signature"],
               "regionNote": database.region_notes().get(basin, "")}
    quality["soilIndependentImperviousKm2"] = soil_independent_area
    reference = database.coverage_reference(basin, year)
    if reference:
        quality["CLCDNoDataInsideBoundaryKm2"] = reference["CLCDNoDataInsideBoundaryKm2"]
    return {"input": {"rainUnit": "mm", "layer": {"year": year, "version": "CLCD {} 核心研究区".format(year),
                        "cnSource": "TR-55 初值及本地自定义参数，逐单元保留出处", "rasters": [area["landRaster"]]},
                      "soilLayer": {"version": "HYSOGs250m", "rasters": [area["soilRaster"]], "source": database.SOIL_SOURCE,
                                    "drainage": drainage, "drainageSource": drainage_source},
                      "precipitation": {key: info[key] for key in ("name", "variable", "units", "start", "end", "dayBoundary")},
                      "moisture": moisture, "units": units},
            "dates": dates, "quality": quality, "waterUnits": water}
