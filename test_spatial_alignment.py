import unittest
import database
import spatial
import numpy as np
from rasterio.vrt import WarpedVRT
from rasterio.windows import Window
from rasterio.warp import transform


class AlignmentTest(unittest.TestCase):
    def test_source_grid_lookup_matches_independent_coordinates(self):
        land = next(row for row in database.catalogue()["layers"] if row["year"] == 2021 and row["basin"] == "秦淮河")
        clipped_soil = database.ROOT / "data/HYSOGs250m/04_秦淮河_HYSOGs250m.tif"
        differences = 0
        with database.rasterio.open(database.ROOT / land["path"]) as target, database.rasterio.open(clipped_soil) as source:
            data = source.read(1)
            with WarpedVRT(source, crs=target.crs, transform=target.transform, width=target.width,
                           height=target.height, nodata=255, tolerance=getattr(spatial, "WARP_TOLERANCE", .125)) as vrt:
                for row in range(0, target.height, 512):
                    for col in range(0, target.width, 512):
                        window = Window(col, row, min(512, target.width - col), min(512, target.height - row))
                        classes = target.read(1, window=window)
                        rr, cc = np.indices(classes.shape)
                        selected = (classes >= 1) & (classes <= 9) & (rr % 23 == 0) & (cc % 23 == 0)
                        if not selected.any():
                            continue
                        x, y = database.rasterio.transform.xy(target.transform, rr[selected] + row, cc[selected] + col)
                        lon, lat = transform(target.crs, source.crs, x, y)
                        sr, sc = source.index(lon, lat)
                        sr, sc = np.asarray(sr, dtype=int), np.asarray(sc, dtype=int)
                        inside = (sr >= 0) & (sr < source.height) & (sc >= 0) & (sc < source.width)
                        expected = np.full(len(sr), 255, dtype="uint8")
                        expected[inside] = data[sr[inside], sc[inside]]
                        differences += int(np.count_nonzero(expected != vrt.read(1, window=window)[selected]))
        self.assertEqual(differences, 0)


if __name__ == "__main__":
    unittest.main()
