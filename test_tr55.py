import json
import tempfile
import unittest
from pathlib import Path
import database
import import_tr55


class TR55Test(unittest.TestCase):
    def test_four_tables_and_missing_group(self):
        profiles = import_tr55.parse_page((import_tr55.DIRECTORY / "hec_cn_tables.html").read_text("utf-8"))
        self.assertEqual(len(profiles), 81)
        self.assertEqual(sum(value is not None for row in profiles for value in row["cn"].values()), 312)
        first_arid = next(row for row in profiles if row["id"] == "2-2d:2")
        self.assertIsNone(first_arid["cn"]["A"])
        defaults = import_tr55.default_parameters(profiles)
        mapping = {(row["landCode"], row["soil"]): row["cn"] for row in defaults}
        self.assertEqual(len(mapping), 24)
        self.assertEqual(mapping[1, "C"], 85)
        self.assertEqual(mapping[2, "D"], 77)
        self.assertEqual(mapping[8, "A"], 98)
        self.assertNotIn((5, "D"), mapping)

    def test_import_is_repeatable_and_preserves_custom_cn(self):
        original_db = database.DB
        original_directory = import_tr55.DIRECTORY
        with tempfile.TemporaryDirectory() as directory:
            try:
                database.DB = Path(directory) / "test.sqlite3"
                import_tr55.DIRECTORY = Path(directory)
                (Path(directory) / "hec_cn_tables.html").write_bytes(
                    (original_directory / "hec_cn_tables.html").read_bytes())
                first = import_tr55.import_tables()
                self.assertEqual(first["initialParametersAdded"], 24)
                database.save_parameters([{"landCode": 1, "soil": "C", "cn": 80,
                                          "source": "local survey", "conditions": "local setting"}])
                second = import_tr55.import_tables()
                self.assertEqual(second["initialParametersAdded"], 0)
                with database.connect() as connection:
                    value = connection.execute("SELECT cn FROM cn_parameters WHERE land_code=1 AND soil='C'").fetchone()[0]
                    self.assertEqual(value, 80)
                    self.assertEqual(connection.execute("SELECT COUNT(*) FROM tr55_reference").fetchone()[0], 81)
                archive = json.loads((Path(directory) / "tr55_reference.json").read_text("utf-8"))
                self.assertEqual(len(archive["sha256"]), 64)
            finally:
                database.DB = original_db
                import_tr55.DIRECTORY = original_directory


if __name__ == "__main__":
    unittest.main()
