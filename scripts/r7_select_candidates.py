"""Round 7: pick Coelho cards (from scripts/r7_coelho_inventory.py) that could be one of the unresolved Viva houses.

Card fields only (lot m2 needs the detail page): built within BUILD_TOL, price within PRICE_TOL, suites within 1.
Tolerances cover the 99th percentile of the 59 live positives (built <=0.32 at max, price <=0.29, suites differ <= 1).
Writes data/r7-extra/live-listing-inventory/coelhodafonseca.json (input of scrape-live-listing-details.js).
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fuse_scores import ROOT  # noqa: E402
from lib.ground_truth import load_nomatch_live  # noqa: E402
from lib.listings import load_pool  # noqa: E402
from topk_agg import COMPOUNDS  # noqa: E402

BUILD_TOL, PRICE_TOL = 0.25, 0.20


def rel(a, b):
    return abs(a - b) / max(a, b) if a and b else None


def main():
    inv = json.loads((ROOT / "data/r7/inv-alphaville-all.json").read_text())["cards"]
    known = {x["code"] for comp in COMPOUNDS for x in load_pool(comp)["coelho"] if x.get("in_fresh")}
    vivas = {x["code"]: x for comp in COMPOUNDS for x in load_pool(comp)["viva"]}
    targets = [vivas[v] for v in load_nomatch_live() if v in vivas]
    keep, why = {}, {}
    for c in inv:
        if c["code"] in known or not (c.get("kind") or "").startswith(("Casa", "Sobrado")):
            continue
        for v in targets:
            rb, rp = rel(c["area_m2"], v["built_m2"]), rel(c["price"], v["price"])
            if (rb is None or rb <= BUILD_TOL) and (rp is None or rp <= PRICE_TOL) and \
                    (c["suites"] is None or v["suites"] is None or abs(c["suites"] - v["suites"]) <= 1):
                keep[c["code"]] = c
                why.setdefault(c["code"], []).append(v["code"])
    out = ROOT / "data/r7-extra/live-listing-inventory/coelhodafonseca.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"source_url": "r7 broad Alphaville category crawl", "total_listings": len(keep),
                               "listings": [{"code": k, "url": c["url"], "condo": c["condo"], "for_vivas": why[k]} for k, c in keep.items()]}, indent=1))
    print(f"{len(keep)} candidate Coelho houses (of {len(inv)} cards, {len(known)} already known) -> {out}")


if __name__ == "__main__":
    main()
