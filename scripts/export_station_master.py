"""Export the CPS station-basic workbook to compact JSON for map matching."""

from __future__ import annotations

import json
import re
import sys
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"


def column_index(reference: str) -> int:
    match = re.match(r"[A-Z]+", reference)
    if not match:
        raise ValueError(reference)
    value = 0
    for char in match.group(0):
        value = value * 26 + ord(char) - ord("A") + 1
    return value - 1


def cell_text(cell: ET.Element) -> str:
    if cell.attrib.get("t") == "inlineStr":
        return "".join(node.text or "" for node in cell.findall(f".//{NS}t"))
    value = cell.find(f"{NS}v")
    return "" if value is None or value.text is None else value.text


def main() -> None:
    source, output = map(Path, sys.argv[1:3])
    with zipfile.ZipFile(source) as archive:
        root = ET.fromstring(archive.read("xl/worksheets/sheet1.xml"))
    sheet_data = root.find(f"{NS}sheetData")
    if sheet_data is None:
        raise RuntimeError("Missing worksheet data")
    rows: list[list[str]] = []
    for row_node in sheet_data.findall(f"{NS}row"):
        values = {
            column_index(cell.attrib.get("r", "")): cell_text(cell)
            for cell in row_node.findall(f"{NS}c")
        }
        rows.append([values.get(index, "") for index in range(16)])
    expected = ("城市", "行政區", "場站代號", "場站名稱", "座標")
    if not rows or tuple(rows[0][index] for index in (1, 2, 4, 5, 9)) != expected:
        raise RuntimeError("Unexpected station-basic workbook headers")
    stations = []
    for row in rows[1:]:
        station_id = row[4].strip()
        if not station_id.startswith(("5001", "5002")):
            continue
        lat_text, lng_text = (part.strip() for part in row[9].split(",", 1))
        stations.append([row[5].strip(), row[1].strip(), row[2].strip(), float(lat_text), float(lng_text), station_id])
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(stations, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"WROTE {output} ({len(stations)} stations)")


if __name__ == "__main__":
    main()
