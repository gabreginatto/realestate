#!/usr/bin/env python3
"""Import reviewer decisions from the review UI (GCS) into data/ground_truth.json.

Sources under gs://<bucket>/review-sessions/: events/<trial>/*.json (decision_confirmed /
decision_skipped / decision_unsure), trial-summaries/*.json, final-matches.json.
The review UI has no explicit "reject" action; skip/unsure are NOT negatives unless
--skips-as-negatives is given. Existing entries are never removed or downgraded.

Usage: python3 scripts/import-review-gt.py [--workdir DIR] [--no-download] [--skips-as-negatives] [--dry-run]
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import tempfile
from collections import defaultdict
from pathlib import Path

BUCKET = "gs://realestate-475615-data/review-sessions"
GT_PATH = Path(__file__).resolve().parents[1] / "data" / "ground_truth.json"
CONDO_RE = re.compile(r"(alphaville)-0?1|(tambore)-xi", re.I)


def norm(code) -> str:
    s = re.sub(r"\D", "", str(code))
    return s.lstrip("0") or s


def download(workdir: Path) -> None:
    workdir.mkdir(parents=True, exist_ok=True)
    for sub in ("events", "trial-summaries"):
        subprocess.run(["gsutil", "-q", "-m", "cp", "-r", f"{BUCKET}/{sub}", str(workdir)], check=False)
    for f in ("current.json", "final-matches.json"):
        subprocess.run(["gsutil", "-q", "cp", f"{BUCKET}/{f}", str(workdir)], check=False)


def load(p: Path):
    try:
        return json.loads(p.read_text())
    except Exception:
        return None


def condo_from_url(url: str):
    m = CONDO_RE.search(url or "")
    if not m:
        return None
    return "alphaville-1" if m.group(1) else "tambore-xi"


def collect(workdir: Path):
    """Return (decisions, trial_condo). decisions: {(viva,coelho): dict(status, ts, trial, round, condo)} last wins."""
    ev = []
    trial_condo = {}
    for f in (workdir / "events").glob("*/*.json"):
        d = load(f)
        if not d:
            continue
        comp = (d.get("client") or {}).get("compound")
        if comp:
            trial_condo[d["trial_run_id"]] = comp
        if d.get("type") in ("decision_confirmed", "decision_skipped", "decision_unsure"):
            ev.append(d)
    ev.sort(key=lambda d: d["ts"])
    dec = {}
    for d in ev:
        key = (norm(d["viva_code"]), norm(d["coelho_code"]))
        dec[key] = dict(status=d["type"].split("_")[1], ts=d["ts"], trial=d["trial_run_id"], round=d.get("pass"))
    # fallback: summaries / final-matches for confirmations not present in events
    for f in (workdir / "trial-summaries").glob("*.json"):
        s = load(f)
        for m in (s or {}).get("confirmed_matches", []) if isinstance(s, dict) else []:
            key = (norm(m["viva_code"]), norm(m["coelho_code"]))
            if key not in dec:
                dec[key] = dict(status="confirmed", ts=m.get("confirmed_at", ""), trial=s.get("trial_run_id") or f.stem, round=s.get("pass"))
            if "url" in (m.get("viva") or {}):
                dec[key]["condo"] = condo_from_url(m["viva"]["url"])
    for key, v in dec.items():
        v.setdefault("condo", trial_condo.get(v["trial"]))
    return dec


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--workdir", default=str(Path(tempfile.gettempdir()) / "review-gt"))
    ap.add_argument("--no-download", action="store_true")
    ap.add_argument("--skips-as-negatives", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    wd = Path(a.workdir)
    if not a.no_download:
        download(wd)
    dec = collect(wd)
    gt = json.loads(GT_PATH.read_text())
    gt.setdefault("negatives", [])
    pos = {(p["viva"], p["coelho"]): p for p in gt["positives"]}
    neg = {(n["viva"], n["coelho"]): n for n in gt["negatives"]}
    added_p = added_n = 0
    conflicts = []
    for (v, c), d in sorted(dec.items(), key=lambda kv: kv[1]["ts"]):
        src = f"review-ui:{d['trial'][:8]}/r{d['round']}"
        if d["status"] == "confirmed":
            if (v, c) in neg:
                conflicts.append(f"confirmed+negative {v}/{c}")
            if (v, c) not in pos:
                e = {"viva": v, "coelho": c, "source": src, "status": "confirmed", "confirmed_at": d["ts"]}
                if d.get("condo"):
                    e["condo"] = d["condo"]
                pos[(v, c)] = e
                added_p += 1
            elif d.get("condo") and "condo" not in pos[(v, c)]:
                pos[(v, c)]["condo"] = d["condo"]
        elif d["status"] == "skipped" and a.skips_as_negatives and (v, c) not in neg and (v, c) not in pos:
            e = {"viva": v, "coelho": c, "source": src}
            if d.get("condo"):
                e["condo"] = d["condo"]
            neg[(v, c)] = e
            added_n += 1
    by_viva = defaultdict(set)
    for (v, c), p in pos.items():
        if p.get("status", "confirmed") == "confirmed":
            by_viva[v].add(c)
    by_coelho = defaultdict(set)
    for (v, c), p in pos.items():
        if p.get("status", "confirmed") == "confirmed":
            by_coelho[c].add(v)
    conflicts += [f"viva {v} -> {sorted(cs)}" for v, cs in by_viva.items() if len(cs) > 1]
    conflicts += [f"coelho {c} <- {sorted(vs)}" for c, vs in by_coelho.items() if len(vs) > 1]
    gt["positives"] = list(pos.values())
    gt["negatives"] = list(neg.values())
    statuses = defaultdict(int)
    for d in dec.values():
        statuses[d["status"]] += 1
    print(f"decisions by final status: {dict(statuses)}; added positives={added_p} negatives={added_n}")
    print(f"total positives={len(gt['positives'])} negatives={len(gt['negatives'])}")
    for c in conflicts:
        print("CONFLICT:", c)
    if not a.dry_run:
        out = '{\n "version": %d,\n "positives": [\n%s\n ],\n "negatives": [%s]\n}\n' % (
            gt.get("version", 1),
            ",\n".join("  " + json.dumps(p, ensure_ascii=False) for p in gt["positives"]),
            ("\n" + ",\n".join("  " + json.dumps(n) for n in gt["negatives"]) + "\n ") if gt["negatives"] else "",
        )
        GT_PATH.write_text(out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
