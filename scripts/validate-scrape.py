#!/usr/bin/env python3
"""Compare a fresh scrape against the production listings, field by field.

Usage: python3 scripts/validate-scrape.py FRESH_DIR [--tolerance 0.01]
FRESH_DIR holds vivaprimeimoveis.json / coelhodafonseca.json from
scripts/scrape-live-listing-details.js. Prints agreement per field per site.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lib.listings import load_fresh_listings, load_listings  # noqa: E402

FIELDS = ["price", "beds", "suites", "vagas", "built_m2", "lot_m2"]


def agree(a, b, tol):
    if a is None and b is None:
        return True
    if a is None or b is None:
        return False
    return abs(a - b) <= tol * max(abs(a), abs(b), 1e-9)


def fresh_status(fresh_dir):
    """{site: ({code: transaction}, removed_codes)} from the raw fresh files."""
    out = {}
    for key, name in (("viva", "vivaprimeimoveis"), ("coelho", "coelhodafonseca")):
        f = Path(fresh_dir) / f"{name}.json"
        data = json.loads(f.read_text()) if f.exists() else {"listings": [], "errors": []}
        tx = {str(i["propertyCode"]): i.get("transaction") for i in data["listings"]}
        removed = {str(i["propertyCode"]) for i in data["listings"] if i.get("detailedData", {}).get("title") is None}
        gone = len(data.get("errors", []))
        out[key] = (tx, removed, gone)
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("fresh_dir")
    ap.add_argument("--tolerance", type=float, default=0.01)
    ap.add_argument("--verbose", action="store_true", help="print each disagreement")
    args = ap.parse_args()

    prod = load_listings()
    fresh = load_fresh_listings(fresh_dir=args.fresh_dir)
    status = fresh_status(args.fresh_dir)
    for site in ("viva", "coelho"):
        p = {x["code"]: x for x in prod[site]}
        f = fresh[site]
        tx, removed, gone = status[site]
        matched = [(p[x["code"]], x) for x in f if x["code"] in p and x["code"] not in removed]
        print(
            f"[{site}] fetched={len(f)} removed_from_site={len(removed)} http_errors(404)={gone} "
            f"compared={len(matched)}"
        )
        for field in FIELDS:
            pairs = matched
            if field == "price":  # rentals show monthly rent, not a sale price
                pairs = [(a, b) for a, b in matched if tx.get(b["code"]) != "locacao"]
                print(f"  ({len(matched) - len(pairs)} rental listing(s) excluded from price)")
            ok = [agree(a[field], b[field], args.tolerance) for a, b in pairs]
            both_missing = sum(a[field] is None and b[field] is None for a, b in pairs)
            print(f"  {site} {field}: {sum(ok)}/{len(ok)}  (both missing: {both_missing})")
            if args.verbose:
                for (a, b), good in zip(pairs, ok):
                    if not good:
                        print(f"      {a['code']}: prod={a[field]} fresh={b[field]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
