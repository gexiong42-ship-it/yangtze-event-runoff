import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import database
import event_input
import numpy as np


class ImperviousCoverageTest(unittest.TestCase):
    def test_equal_four_group_cn_does_not_require_soil_for_impervious(self):
        original = database.DB
        with tempfile.TemporaryDirectory() as directory:
            try:
                database.DB = Path(directory) / "test.sqlite3"
                with sqlite3.connect(str(original)) as source, database.connect() as target:
                    source.backup(target)
                database.save_parameters([{"landCode": 8, "soil": soil, "cn": 98,
                                           "source": "TR-55 test fixture", "conditions": "paved"}
                                          for soil in "ABCD"])
                config = {"basin": "test", "start": "2021-07-01", "end": "2021-07-01"}
                dates, _ = event_input.period(config)
                fields = {day: np.array([10], dtype="float32") for day in dates["antecedent"] + dates["event"]}
                area = {"groups": [{"grid": 0, "landCode": 8, "soilCode": 255, "areaKm2": 1},
                                   {"grid": 0, "landCode": 1, "soilCode": 255, "areaKm2": 1}],
                        "totalAreaKm2": 2, "method": "fixture", "signature": "fixture",
                        "landRaster": "fixture", "soilRaster": "fixture"}
                info = {"name": "test", "variable": "pre", "units": "mm/day", "start": "1980-01-01",
                        "end": "2022-12-31", "dayBoundary": "test"}
                with patch.object(event_input.precipitation, "read_days", return_value=(info, fields)), patch.object(event_input.spatial, "weights", return_value=area):
                    result = event_input.assemble(config)
                self.assertEqual(len(result["input"]["units"]), 1)
                self.assertEqual(result["input"]["units"][0]["referenceCN"], 98)
                self.assertEqual(result["quality"]["landAreaKm2"], 1)
                self.assertEqual(result["quality"]["excluded"]["土组缺测"], 1)
                # When local CN values differ across HSGs, soil remains required.
                database.save_parameters([{"landCode": 8, "soil": "A", "cn": 90,
                                           "source": "local test", "conditions": "local"}])
                with patch.object(event_input.precipitation, "read_days", return_value=(info, fields)), patch.object(event_input.spatial, "weights", return_value=area):
                    with self.assertRaisesRegex(ValueError, "没有同时具备"):
                        event_input.assemble(config)
            finally:
                database.DB = original


if __name__ == "__main__":
    unittest.main()
