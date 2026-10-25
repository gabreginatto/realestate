#!/usr/bin/env python3
"""Import broker labels from the Firestore label page into data/ground_truth.json.

match    -> one positive per coelho code (source "label-site:<by-prefix>", status confirmed, labeled_at, condo)
no_match -> top-level "nomatch_live": [{viva, condo, as_of, source, by}] (viva not among Coelho's LIVE listings)
unsure   -> ignored (counted)
Idempotent. Conflicts are reported, not applied: a match whose coelho differs from an existing positive that is
still live is added but flagged; a no_match for a viva whose existing GT coelho is live is skipped.
Liveness comes from the candidates file (all live viva x live coelho pairs).

Usage: python3 scripts/import-label-site.py [--from-file labels.json] [--exclude-by u_x9B9] [--dry-run]
"""
from __future__ import annotations

import argparse
import json
import urllib.request
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
GT = ROOT / "data" / "ground_truth.json"
URL = "https://firestore.googleapis.com/v1/projects/property-matcher-139a4/databases/(default)/documents/labels?pageSize=300"
COMPOUNDS = ("alphaville-1", "tambore-xi")


def fetch_remote():
    docs, tok = [], None
    while True:
        with urllib.request.urlopen(URL + (f"&pageToken={tok}" if tok else ""), timeout=30) as r:
            page = json.load(r)
        docs += page.get("documents", [])
        tok = page.get("nextPageToken")
        if not tok:
            return docs


def flat(doc):
    out = {}
    for k, v in doc["fields"].items():
        out[k] = None if "nullValue" in v else next(iter(v.values()))
    return out


def load_labels(path):
    raw = json.loads(Path(path).read_text()) if path else fetch_remote()
    docs = raw.get("documents", raw) if isinstance(raw, dict) else raw
    return [flat(d) if "fields" in d else d for d in docs]


def viva_condos():
    out = {}
    for comp in COMPOUNDS:
        inv = json.loads((ROOT / "data" / comp / "live-listing-inventory/vivaprimeimoveis.json").read_text())
        out.update({str(x["code"]): comp for x in inv["listings"]})
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--from-file")
    ap.add_argument("--candidates", type=Path, default=ROOT / "data/candidates/topk-agg-live-count-v1.json")
    ap.add_argument("--exclude-by", action="append", default=[], help="author prefix to skip (e.g. u_x9B9)")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    labels = [l for l in load_labels(args.from_file) if not any(str(l["by"]).startswith(p) for p in args.exclude_by)]
    live = {v: {str(c["coelho"]) for c in cs} for v, cs in json.loads(args.candidates.read_text())["candidates"].items()}
    condo_of = viva_condos()
    gt = json.loads(GT.read_text())
    pos = gt["positives"]
    have = {(p["viva"], p["coelho"]) for p in pos}
    existing = {}
    for p in pos:
        if p.get("status", "confirmed") == "confirmed":
            existing.setdefault(p["viva"], set()).add(p["coelho"])
    nm = {n["viva"]: n for n in gt.get("nomatch_live", [])}

    counts, added, conflicts = Counter(), [], []
    for l in sorted(labels, key=lambda l: l["at"]):
        v, d, by = str(l["viva"]), l["decision"], str(l["by"])
        counts[(by[:6], d, condo_of.get(v, "?"))] += 1
        condo, src, day = condo_of.get(v, "unknown"), "label-site:" + by[:6], str(l["at"])[:10]
        ex_live = {c for c in existing.get(v, ()) if c in live.get(v, ())}
        if d == "match":
            for c in [x.strip() for x in (l["coelho"] or "").split(",") if x.strip()]:
                if ex_live and c not in ex_live:
                    conflicts.append(f"match viva {v}: label {c} vs existing live GT {sorted(ex_live)} (added anyway)")
                if c not in live.get(v, ()):
                    conflicts.append(f"match viva {v}: viva/coelho {c} not live today (stale label, skipped)")
                    continue
                if (v, c) not in have:
                    pos.append({"viva": v, "coelho": c, "source": src, "status": "confirmed", "condo": condo,
                                "labeled_at": str(l["at"])})
                    have.add((v, c)); existing.setdefault(v, set()).add(c); added.append((v, c))
            nm.pop(v, None)
        elif d == "no_match":
            if ex_live:
                conflicts.append(f"no_match viva {v}: existing GT coelho {sorted(ex_live)} is still live (skipped)")
            else:
                nm[v] = {"viva": v, "condo": condo, "as_of": day, "source": src, "by": by}
    gt["nomatch_live"] = sorted(nm.values(), key=lambda n: n["viva"])
    if not args.dry_run:
        GT.write_text(json.dumps(gt, indent=2, ensure_ascii=False) + "\n")
    print("labels (author, decision, compound):")
    for k, n in sorted(counts.items()):
        print(" ", *k, n)
    print(f"new positives: {len(added)}; nomatch_live: {len(gt['nomatch_live'])}; conflicts: {len(conflicts)}")
    for c in conflicts:
        print("  CONFLICT", c)


if __name__ == "__main__":
    main()
