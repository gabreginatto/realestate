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


if __name__ == "__main__":
    assert len(load_ground_truth(include_disputed=True)) >= len(load_ground_truth()) >= 20
    assert not (load_ground_truth() & load_negatives())
    assert ("17378", "659639") not in load_ground_truth()
    print("ground_truth self-check ok")
