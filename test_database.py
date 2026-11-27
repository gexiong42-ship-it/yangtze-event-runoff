import sqlite3
import tempfile
import unittest
from pathlib import Path
import database
from database import rasterio, transform
from rasterio.windows import Window


class DatabaseTest(unittest.TestCase):
    def setUp(self):
        self.original = database.DB
        self.temp = tempfile.TemporaryDirectory()
        database.DB = Path(self.temp.name) / "test.sqlite3"
        with sqlite3.connect(str(self.original)) as source, database.connect() as target:
            source.backup(target)
        with database.connect() as connection:
            connection.execute("DELETE FROM cn_parameters")

    def tearDown(self):
        database.DB = self.original
        self.temp.cleanup()

    def point(self, year):
        layer = next(row for row in database.catalogue()["layers"] if row["year"] == year)
        with rasterio.open(database.ROOT / layer["path"]) as dataset:
            window = Window(dataset.width // 3, dataset.height // 3, 512, 512)
            band = dataset.read(1, window=window)
            indices = ((band >= 1) & (band <= 9)).nonzero()
            row, col = int(indices[0][0]) + window.row_off, int(indices[1][0]) + window.col_off
            x, y = dataset.xy(row, col)
            longitude, latitude = transform(dataset.crs, "EPSG:4326", [x], [y])
            code = int(band[indices[0][0], indices[1][0]])
        return {"units": [{"id": "test", "basin": layer["basin"], "longitude": longitude[0],
                           "latitude": latitude[0], "soil": "B"}]}, code

    def test_catalogue(self):
        data = database.catalogue()
        self.assertEqual(len(data["layers"]), 185)
        self.assertEqual(len(data["years"]), 37)
        self.assertNotIn(1989, data["years"])
        self.assertEqual(data["cnParameterCount"], 0)

    def test_spatial_cn_and_year(self):
        database.save_parameters([{"landCode": code, "soil": soil, "cn": 50 + code,
                                   "source": "test fixture", "conditions": "test only"}
                                  for code in range(1, 10) for soil in ("A", "B", "C", "D")])
        for year in [1990, 2025]:
            data, code = self.point(year)
            result = database.prepare(data, year)
            self.assertEqual(result["layer"]["year"], year)
            self.assertEqual(result["units"][0]["landCode"], code)
            self.assertEqual(result["units"][0]["referenceCN"], 50 + code)
            self.assertIn(result["units"][0]["soil"], ("A", "B", "C", "D"))
            self.assertIn("soilOriginal", result["units"][0])
            self.assertNotIn("referenceCN", data["units"][0])
        with self.assertRaisesRegex(ValueError, "没有"):
            database.prepare(data, 2026)

    def test_missing_parameters_and_outside(self):
        data, code = self.point(2025)
        with self.assertRaisesRegex(ValueError, "缺少 CN"):
            database.prepare(data, 2025)
        preview = database.prepare(data, 2025, allow_incomplete=True)
        self.assertTrue(preview["missingCN"])
        self.assertIsNone(preview["units"][0]["referenceCN"])
        self.assertIn("soilCode", preview["units"][0])
        data["units"][0]["longitude"] = 0
        data["units"][0]["latitude"] = 0
        with self.assertRaisesRegex(ValueError, "超出"):
            database.prepare(data, 2025)

    def test_parameters_are_atomic(self):
        with self.assertRaises(ValueError):
            database.save_parameters([
                {"landCode": 1, "soil": "B", "cn": 70, "source": "test", "conditions": "test"},
                {"landCode": 2, "soil": "B", "cn": 101, "source": "test", "conditions": "test"}])
        self.assertEqual(database.catalogue()["cnParameterCount"], 0)

    def test_soil_catalogue_and_dual_groups(self):
        self.assertEqual(len(database.catalogue()["soilLayers"]), 5)
        with database.connect() as connection:
            layer = dict(connection.execute("SELECT * FROM soil_rasters WHERE codes_json LIKE '%13%'").fetchone())
        with rasterio.open(database.ROOT / layer["path"]) as dataset:
            for code, original, drained in [(13, "C/D", "C")]:
                rows, cols = (dataset.read(1) == code).nonzero()
                x, y = dataset.xy(int(rows[0]), int(cols[0]))
                longitude, latitude = transform(dataset.crs, "EPSG:4326", [x], [y])
                self.assertEqual(database.read_soil(layer, longitude[0], latitude[0], "undrained"), (code, original, "D"))
                self.assertEqual(database.read_soil(layer, longitude[0], latitude[0], "drained"), (code, original, drained))
        with self.assertRaisesRegex(ValueError, "排水依据"):
            database.prepare({"units": [{}]}, 2025, "drained")

    def test_soil_nodata(self):
        with database.connect() as connection:
            layer = dict(connection.execute("SELECT * FROM soil_rasters LIMIT 1").fetchone())
        with rasterio.open(database.ROOT / layer["path"]) as dataset:
            rows, cols = (dataset.read(1) == 255).nonzero()
            x, y = dataset.xy(int(rows[0]), int(cols[0]))
            longitude, latitude = transform(dataset.crs, "EPSG:4326", [x], [y])
        with self.assertRaisesRegex(ValueError, "缺测"):
            database.read_soil(layer, longitude[0], latitude[0], "undrained")


if __name__ == "__main__":
    unittest.main()
