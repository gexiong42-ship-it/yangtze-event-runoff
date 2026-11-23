"""Import the downloaded HEC TR-55 page, preserving every table alternative."""
import hashlib
import json
import re
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
import database

URL = "https://www.hec.usace.army.mil/confluence/hmsdocs/hmstrm/cn-tables"
DIRECTORY = database.ROOT / "data" / "TR55"


class TableParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.tables = []
        self.table = None
        self.cell = None
        self.in_superscript = False

    def handle_starttag(self, tag, attributes):
        if tag == "table":
            self.table = []
            self.tables.append(self.table)
        if self.table is not None and tag == "tr":
            self.row = []
            self.table.append(self.row)
        if self.table is not None and tag in ("td", "th"):
            self.cell = []
            self.attributes = dict(attributes)
        if tag == "sup":
            self.in_superscript = True
        if tag == "br" and self.cell is not None:
            self.cell.append(" ")

    def handle_endtag(self, tag):
        if tag == "sup":
            self.in_superscript = False
        if tag in ("td", "th") and self.cell is not None:
            self.row.append((" ".join("".join(self.cell).split()), self.attributes))
            self.cell = None
        if tag == "table":
            self.table = None

    def handle_data(self, text):
        if self.cell is not None and not self.in_superscript:
            self.cell.append(text)


def expand_spans(rows):
    grid = {}
    result = []
    for row_index, cells in enumerate(rows):
        column = 0
        for text, attributes in cells:
            while (row_index, column) in grid:
                column += 1
            width = int(attributes.get("colspan", 1))
            height = int(attributes.get("rowspan", 1))
            for row in range(row_index, row_index + height):
                for col in range(column, column + width):
                    grid[row, col] = text
            column += width
        columns = [col for row, col in grid if row == row_index]
        result.append([grid.get((row_index, col), "") for col in range(max(columns, default=-1) + 1)])
    return result


def parse_page(content):
    parser = TableParser()
    parser.feed(content)
    if len(parser.tables) != 4:
        raise ValueError("页面表格结构已变化，预期为四张 TR-55 表。")
    profiles = []
    for table_index, raw in enumerate(parser.tables):
        table_id = "2-2" + "abcd"[table_index]
        expanded = expand_spans(raw)
        cover = ""
        treatment = ""
        urban_context = ""
        for row_index, cells in enumerate(expanded[2:], 2):
            if table_index == 0 and not any(re.fullmatch(r"\d+", value) for value in cells[-4:]):
                urban_context = cells[0].rstrip(":")
            # The published table 2-2c has empty layout cells between values.
            if table_index == 2:
                values = [text for text, _ in raw[row_index] if re.fullmatch(r"\d+", text)]
            else:
                values = cells[-4:]
            if len(values) != 4 or not all(not value or re.fullmatch(r"\d+", value) for value in values):
                continue
            if not any(values):
                continue
            cn = {soil: int(value) if value else None for soil, value in zip("ABCD", values)}
            if any(value is not None and not 0 < value <= 100 for value in cn.values()):
                raise ValueError("发现无效 CN 数值。")
            condition = ""
            impervious = None
            if table_index == 0:
                cover = re.sub(r"(?:\s*\.)+\s*$", "", cells[0]).strip()
                cover = urban_context + " / " + cover
                impervious = int(cells[1]) if cells[1].isdigit() else None
            elif table_index == 1:
                cover = cells[0]
                treatment = cells[1] or treatment
                condition = cells[2]
            elif table_index == 2:
                groups = [(2, 4, "Pasture, grassland, or range"),
                          (6, 6, "Meadow"), (9, 11, "Brush"),
                          (13, 15, "Woods–grass combination"), (17, 19, "Woods"),
                          (21, 21, "Farmsteads")]
                cover = next(label for first, last, label in groups if first <= row_index <= last)
                condition = cells[1]
            else:
                cover = cells[0]
                condition = cells[1]
            profiles.append({"id": table_id + ":" + str(row_index), "table": table_id,
                             "cover": cover, "treatment": treatment if table_index == 1 else "",
                             "condition": condition, "imperviousPercent": impervious, "cn": cn,
                             "arc": "II / average", "lambda": 0.2, "source": URL,
                             "rawCells": [text for text, _ in raw[row_index]]})
    by_id = {row["id"]: row for row in profiles}
    checks = {"2-2a:8": [98, 98, 98, 98], "2-2b:6": [67, 78, 85, 89],
              "2-2c:19": [30, 55, 70, 77], "2-2c:11": [30, 48, 65, 73],
              "2-2c:4": [39, 61, 74, 80], "2-2b:2": [77, 86, 91, 94],
              "2-2d:2": [None, 80, 87, 93]}
    for key, expected in checks.items():
        if list(by_id.get(key, {}).get("cn", {}).values()) != expected:
            raise ValueError("原表校验失败 " + key)
    if len(profiles) != 81:
        raise ValueError("CN 表记录数量与核验版本不符。")
    return profiles


def default_parameters(profiles):
    by_id = {row["id"]: row for row in profiles}
    choices = [
        (1, "2-2b:6", "初值假设：直行种植作物，良好水文条件；CLCD 耕地包含多种农作物，须按实际耕作核对"),
        (2, "2-2c:19", "初值假设：林地，良好水文条件，林下枯落物与灌木覆盖充分"),
        (3, "2-2c:11", "初值假设：灌木为主，良好水文条件，地面覆盖率 >75%"),
        (4, "2-2c:4", "初值假设：草地，良好水文条件，地面覆盖率 >75%"),
        (7, "2-2b:2", "初值假设：裸地参照休耕裸土"),
        (8, "2-2a:8", "初值假设：不透水面参照直接连通的铺装场地、屋顶；须核对排水连通性"),
    ]
    parameters = []
    for code, profile_id, assumption in choices:
        profile = by_id[profile_id]
        conditions = "{}；TR-55 {} / {} / {} / {}；平均前期径流条件 ARC II，Ia=0.2S".format(
            assumption, profile["table"], profile["cover"], profile["treatment"], profile["condition"])
        for soil, cn in profile["cn"].items():
            parameters.append({"landCode": code, "soil": soil, "cn": cn,
                               "source": "USDA SCS TR-55 Table " + profile["table"] + "；" + URL,
                               "conditions": conditions})
    return parameters


def import_tables():
    snapshot = DIRECTORY / "hec_cn_tables.html"
    content = snapshot.read_bytes()
    profiles = parse_page(content.decode("utf-8"))
    defaults = default_parameters(profiles)
    digest = hashlib.sha256(content).hexdigest()
    retrieved = datetime.fromtimestamp(snapshot.stat().st_mtime, timezone.utc).isoformat()
    with database.connect() as connection:
        connection.execute("DELETE FROM tr55_reference")
        connection.executemany("INSERT INTO tr55_reference VALUES (?,?,?,?,?)", [
            (row["id"], row["table"], json.dumps(row, ensure_ascii=False), digest, retrieved)
            for row in profiles])
        before = connection.total_changes
        connection.executemany("INSERT OR IGNORE INTO cn_parameters VALUES (?,?,?,?,?)", [
            (row["landCode"], row["soil"], row["cn"], row["source"], row["conditions"]) for row in defaults])
        added = connection.total_changes - before
    archive = {"source": URL, "retrievedUTC": retrieved, "sha256": digest,
               "notes": "平均 ARC II，Ia=0.2S；组 A 原表空白保留 null；CN<30 的计算替代值为30；完整脚注见 HTML",
               "profiles": profiles}
    (DIRECTORY / "tr55_reference.json").write_text(json.dumps(archive, ensure_ascii=False, indent=2), encoding="utf-8")
    (DIRECTORY / "clcd_initial_cn.json").write_text(json.dumps(defaults, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"referenceRows": len(profiles), "cnValues": sum(value is not None for row in profiles for value in row["cn"].values()),
            "initialParametersAdded": added}


if __name__ == "__main__":
    print(json.dumps(import_tables(), ensure_ascii=False))
