"""Ground-truth loader for viva/coelho listing pairs.

Usage (from any scripts/*.py):
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from lib.ground_truth import load_ground_truth
"""

from __future__ import annotations

import json
from pathlib import Path

DEFAULT_PATH = Path(__file__).resolve().parents[2] / "data" / "ground_truth.json"


def load_ground_truth(include_disputed=False, path=None):
    """Return the set of (viva_code, coelho_code) confirmed pairs."""
    data = json.loads(Path(path or DEFAULT_PATH).read_text())
    keep = {"confirmed", "disputed"} if include_disputed else {"confirmed"}
    return {
        (str(p["viva"]), str(p["coelho"]))
        for p in data["positives"]
        if p.get("status", "confirmed") in keep
    }


def load_negatives(path=None):
    """Return the set of (viva_code, coelho_code) pairs reviewers rejected."""
    data = json.loads(Path(path or DEFAULT_PATH).read_text())
    return {(str(n["viva"]), str(n["coelho"])) for n in data.get("negatives", [])}


def load_nomatch_live(path=None):
    """Return {viva_code: entry} for vivas the broker found NOT among Coelho's live listings (as_of date)."""
    data = json.loads(Path(path or DEFAULT_PATH).read_text())
    return {str(n["viva"]): n for n in data.get("nomatch_live", [])}


def load_pair_negatives(path=None):
    """Return {(viva, coelho)} hard negatives: Coelho listings the broker saw (label page top-3) and rejected.

    nomatch_live means "none of the shown candidates is this house" (not "the house is not at Coelho"), so the
    viva is not a negative as a whole; only each rejected (viva, shown coelho) pair is. Entries flagged
    needs_recheck contribute only their non-flagged shown pairs. Older entries without rejected_coelho give nothing.
    """
    data = json.loads(Path(path or DEFAULT_PATH).read_text())
    return {(str(n["viva"]), str(c)) for n in data.get("nomatch_live", []) for c in n.get("rejected_coelho", [])}


def load_needs_recheck(path=None):
    """Return {viva: [coelho codes flagged as probably the same house]} from nomatch_live entries."""
    data = json.loads(Path(path or DEFAULT_PATH).read_text())
    return {str(n["viva"]): list(n.get("recheck_coelho", [])) for n in data.get("nomatch_live", []) if n.get("needs_recheck")}


if __name__ == "__main__":
    assert len(load_ground_truth(include_disputed=True)) >= len(load_ground_truth()) >= 20
    assert not (load_ground_truth() & load_negatives())
    assert ("17378", "659639") not in load_ground_truth()
    assert not (load_pair_negatives() & load_ground_truth(include_disputed=True))
    assert len(load_pair_negatives()) >= 100 and "12229" in load_needs_recheck()
    print("ground_truth self-check ok")
