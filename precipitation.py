"""Import daily CN05.1 fields into a self-contained, compressed SQLite store."""
import json
import os
import sqlite3
import zlib
from datetime import date, timedelta
from contextlib import closing
from pathlib import Path
import database
import numpy as np
from netCDF4 import Dataset, num2date

RAIN_DB = database.ROOT / "data" / "precipitation.sqlite3"
SOURCE = Path("D:/中国C05格点降水数据1961-2022/CN05.1_Pre_1961_2022_daily_025x025.nc")


def day_range(start, end):
    first, last = date.fromisoformat(start), date.fromisoformat(end)
    if last < first:
        raise ValueError("结束日期须晚于或等于开始日期。")
    return [(first + timedelta(days=i)).isoformat() for i in range((last - first).days + 1)]


def metadata():
    if not RAIN_DB.exists():
        return None
    with closing(sqlite3.connect(str(RAIN_DB))) as connection:
        return json.loads(connection.execute("SELECT value FROM metadata WHERE key='dataset'").fetchone()[0])


def import_rain(source=SOURCE):
    target = RAIN_DB.with_suffix(".importing.sqlite3")
    if target.exists():
        target.unlink()
    with Dataset(str(source), encoding="gbk" if os.name == "nt" else "utf-8") as dataset:
        variable = dataset.variables["pre"]
        if variable.dimensions != ("time", "lat", "lon") or "mm/day" not in variable.long_name:
            raise ValueError("降水维度或单位与 CN05.1 预期不符。")
        latitudes = np.asarray(dataset.variables["lat"][:], dtype=float)
        longitudes = np.asarray(dataset.variables["lon"][:], dtype=float)
        if not (np.allclose(np.diff(latitudes), .25) and np.allclose(np.diff(longitudes), .25)):
            raise ValueError("坐标网格应为递增的 0.25° 等间隔格点。")
        time = dataset.variables["time"]
        all_days = [value.strftime("%Y-%m-%d") for value in num2date(time[:], time.units, time.calendar)]
        indices = [i for i, value in enumerate(all_days) if "1980-01-01" <= value <= "2022-12-31"]
        days = [all_days[i] for i in indices]
        if days != day_range("1980-01-01", "2022-12-31"):
            raise ValueError("1980–2022 日期存在缺项、重复或顺序异常。")
        info = {"name": "CN05.1", "variable": "pre", "units": "mm/day", "start": days[0],
                "end": days[-1], "days": len(days), "latitudes": latitudes.tolist(),
                "longitudes": longitudes.tolist(), "source": str(source), "sourceBytes": source.stat().st_size,
                "sourceModifiedNs": source.stat().st_mtime_ns, "calendar": time.calendar,
                "timeUnits": time.units, "dayBoundary": "沿用 NetCDF 原始日值及日期标签",
                "encoding": "zlib compressed little-endian float32, ascending latitude/longitude"}
        with closing(sqlite3.connect(str(target))) as connection:
            connection.executescript("CREATE TABLE metadata (key TEXT PRIMARY KEY,value TEXT NOT NULL);"
                                     "CREATE TABLE daily (day TEXT PRIMARY KEY,field BLOB NOT NULL,missing_count INTEGER NOT NULL);")
            for year in range(1980, 2023):
                positions = [i for i in indices if all_days[i].startswith(str(year))]
                field = np.ma.asarray(variable[positions[0]:positions[-1] + 1]).filled(np.nan).astype("<f4")
                field[field < 0] = np.nan
                rows = [(all_days[position], zlib.compress(field[index].tobytes(), 1),
                         int(np.count_nonzero(~np.isfinite(field[index])))) for index, position in enumerate(positions)]
                connection.executemany("INSERT INTO daily VALUES (?,?,?)", rows)
                connection.commit()
                print("已导入 {} 年 / 2022".format(year), flush=True)
            connection.execute("INSERT INTO metadata VALUES ('dataset',?)", (json.dumps(info, ensure_ascii=False),))
            connection.commit()
            if connection.execute("SELECT COUNT(*) FROM daily").fetchone()[0] != len(days):
                raise ValueError("降水入库数量校验失败。")
    os.replace(str(target), str(RAIN_DB))
    return info


def read_days(days):
    info = metadata()
    if not info:
        raise ValueError("尚未导入 CN05.1 降水资料。")
    fields = {}
    with closing(sqlite3.connect(str(RAIN_DB))) as connection:
        for day in dict.fromkeys(days):
            record = connection.execute("SELECT field FROM daily WHERE day=?", (day,)).fetchone()
            if not record:
                raise ValueError("降水数据库缺少日期 " + day)
            fields[day] = np.frombuffer(zlib.decompress(record[0]), dtype="<f4")
    return info, fields


if __name__ == "__main__":
    print(json.dumps({key: value for key, value in import_rain().items()
                      if key not in ("latitudes", "longitudes")}, ensure_ascii=False))
