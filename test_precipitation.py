import unittest
from datetime import date
import database
import precipitation
import spatial
from event_input import period, assemble
from netCDF4 import Dataset, num2date
import numpy as np


class PrecipitationTest(unittest.TestCase):
    def test_dates_and_custom_moisture(self):
        dates, _ = period({"start": "2020-03-01", "end": "2020-03-02"})
        self.assertEqual(dates["antecedent"][-1], "2020-02-29")
        with self.assertRaisesRegex(ValueError, "五天"):
            period({"start": "2021-07-01", "end": "2021-07-03", "antecedentStart": "2021-06-01", "antecedentEnd": "2021-06-30"})
        dates, moisture = period({"start": "2021-07-01", "end": "2021-07-03",
                                  "antecedentStart": "2021-06-01", "antecedentEnd": "2021-06-30",
                                  "moistureScheme": "custom", "dryBelow": 80, "wetFrom": 150, "moistureSource": "test"})
        self.assertEqual(len(dates["antecedent"]), 30)
        self.assertEqual(moisture["dryBelow"], 80)
        with self.assertRaises(ValueError):
            period({"start": "2021-07-01", "end": "2021-07-03", "antecedentStart": "2021-07-01", "antecedentEnd": "2021-07-05"})

    def test_database_matches_netcdf_including_leap_and_endpoints(self):
        days = ["1980-01-01", "2020-02-29", "2022-12-31"]
        info, fields = precipitation.read_days(days)
        self.assertEqual(info["days"], 15706)
        with Dataset(str(precipitation.SOURCE), encoding="gbk") as dataset:
            time = dataset.variables["time"]
            available = [day.strftime("%Y-%m-%d") for day in num2date(time[:], time.units, time.calendar)]
            for day in days:
                original = np.ma.asarray(dataset.variables["pre"][available.index(day)]).filled(np.nan).astype("<f4").ravel()
                original[original < 0] = np.nan
                np.testing.assert_array_equal(original, fields[day])
        with self.assertRaisesRegex(ValueError, "缺少日期"):
            precipitation.read_days(["1979-12-31"])

    def test_area_conservation_and_event_inputs(self):
        basin = "秦淮河"
        area = spatial.weights(basin, 2021)
        with database.rasterio.open(database.ROOT / area["landRaster"]) as dataset:
            band = dataset.read(1, masked=True)
            count = np.count_nonzero((~np.ma.getmaskarray(band)) & (band.data >= 1) & (band.data <= 9))
        self.assertEqual(sum(group["pixels"] for group in area["groups"]), count)
        self.assertAlmostEqual(area["totalAreaKm2"], count * area["pixelAreaKm2"])
        output = assemble({"basin": basin, "start": "2021-07-01", "end": "2021-07-03"})
        q = output["quality"]
        self.assertAlmostEqual(q["totalAreaKm2"], q["landAreaKm2"] + q["waterAreaKm2"] + q["excludedAreaKm2"])
        self.assertTrue(output["waterUnits"])
        self.assertTrue(output["input"]["units"])
        self.assertTrue(all(unit["landCode"] != 5 for unit in output["input"]["units"]))
        self.assertAlmostEqual(q["waterVolumeM3"], sum(
            unit["areaKm2"] * 1000 * sum(unit["rain"][day] for day in output["dates"]["event"])
            for unit in output["waterUnits"]))
        with self.assertRaisesRegex(ValueError, "土地利用"):
            assemble({"basin": basin, "start": "1980-07-01", "end": "1980-07-03"})


if __name__ == "__main__":
    unittest.main()
