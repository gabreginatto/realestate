"""Normalized listing loader for Viva Prime and Coelho da Fonseca scrapes."""

from __future__ import annotations

import json
import re
from pathlib import Path

DEFAULT_ROOT = Path(__file__).resolve().parents[2] / "data"

# Both production scrapes currently cover only this condominium.
CONDO_ALPHAVILLE_1 = "alphaville-1"


def parse_br_number(value):
    """Parse '1.276,23m²', 'R$ 2.900.000,00', '1234.3m²', '950 m²' -> float or None.

    With a comma: dot is thousands, comma is decimal. Dots only: a pure
    thousands pattern (1.276 / 2.900.000) is thousands, otherwise decimal.
    """
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    m = re.search(r"\d[\d.,]*", str(value))
    if not m:
        return None
    s = m.group(0).rstrip(".,")
    if "," in s:
        s = s.replace(".", "").replace(",", ".")
    elif re.fullmatch(r"\d{1,3}(\.\d{3})+", s):
        s = s.replace(".", "")
    try:
        return float(s)
    except ValueError:
        return None


def _int(value):
    n = parse_br_number(value)
    return None if n is None else int(n)


def _normalize_viva(item):
    specs = (item.get("detailedData") or {}).get("specs") or {}
    return {
        "code": str(item["propertyCode"]),
        "site": "viva",
        "condo": CONDO_ALPHAVILLE_1 if "alphaville-01" in (item.get("url") or "") else None,
        "price": parse_br_number(item.get("price")),
        "built_m2": parse_br_number(specs.get("area_construida")),
        "lot_m2": parse_br_number(specs.get("area_total")),
        "beds": _int(specs.get("dormitorios")),
        "suites": _int(specs.get("suites")),
        "vagas": _int(specs.get("vagas")),
        "url": item.get("url"),
    }


def _feature(features, pattern):
    m = re.search(r"([\d.,]+)\s*" + pattern, features or "", re.I)
    return parse_br_number(m.group(1)) if m else None


def _normalize_coelho(item):
    f = item.get("features") or ""
    loc = (item.get("location") or "").lower()
    n = _feature(f, r"su[ií]tes?")
    return {
        "code": str(item["propertyCode"]),
        "site": "coelho",
        "condo": CONDO_ALPHAVILLE_1 if re.fullmatch(r"alphaville\s*0?1", loc) else None,
        "price": parse_br_number(item.get("price")),
        "built_m2": _feature(f, r"m²\s*constru"),
        "lot_m2": _feature(f, r"m²\s*do terreno"),
        "beds": None if _feature(f, r"dorms?") is None else int(_feature(f, r"dorms?")),
        "suites": None if n is None else int(n),
        "vagas": None if _feature(f, r"vagas?") is None else int(_feature(f, r"vagas?")),
        "url": item.get("url"),
    }


def load_listings(data_root=None):
    """Return {"viva": [dict, ...], "coelho": [dict, ...]} of normalized listings."""
    root = Path(data_root or DEFAULT_ROOT)
    viva = json.loads((root / "vivaprimeimoveis/listings/all-listings.json").read_text())
    coelho = json.loads((root / "coelhodafonseca/listings/all-listings.json").read_text())
    return {
        "viva": [_normalize_viva(i) for i in viva["listings"]],
        "coelho": [_normalize_coelho(i) for i in coelho["listings"]],
    }


def load_fresh_listings(compound=CONDO_ALPHAVILLE_1, data_root=None, fresh_dir=None):
    """Load fresh scrapes (scrape-live-listing-details.js output) in the same normalized shape.

    Reads data/<compound>/fresh-listings/{vivaprimeimoveis,coelhodafonseca}.json, or the same
    file names from fresh_dir. Missing files give empty lists.
    """
    root = Path(data_root or DEFAULT_ROOT)
    base = Path(fresh_dir) if fresh_dir else root / compound / "fresh-listings"
    out = {"viva": [], "coelho": []}
    for key, name, norm in (("viva", "vivaprimeimoveis", _normalize_viva), ("coelho", "coelhodafonseca", _normalize_coelho)):
        f = base / f"{name}.json"
        if f.exists():
            out[key] = [norm(i) for i in json.loads(f.read_text())["listings"]]
    for items in out.values():
        for x in items:
            x["condo"] = x["condo"] or compound
    return out


if __name__ == "__main__":
    assert parse_br_number("1.276,23m²") == 1276.23
    assert parse_br_number("R$ 2.900.000,00") == 2900000.0
    assert parse_br_number("R$32.000.000") == 32000000.0
    assert parse_br_number("1276.23m²") == 1276.23
    assert parse_br_number("281.4m²") == 281.4
    assert parse_br_number("400m²") == 400.0
    assert parse_br_number("950 m²") == 950.0
    assert parse_br_number("") is None and parse_br_number(None) is None
    data = load_listings()
    c = {x["code"]: x for x in data["coelho"]}["663777"]
    assert (c["beds"], c["suites"], c["vagas"], c["built_m2"], c["lot_m2"]) == (5, 5, 8, 950.0, 1145.0)
    assert c["price"] == 32000000.0
    assert all(x["condo"] for x in data["viva"] + data["coelho"])
    print(
        "listings self-check ok: viva=%d coelho=%d coelho_no_price=%d"
        % (len(data["viva"]), len(data["coelho"]), sum(x["price"] is None for x in data["coelho"]))
    )
