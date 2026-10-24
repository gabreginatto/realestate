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


if __name__ == "__main__":
    assert len(load_ground_truth()) == 20
    assert len(load_ground_truth(include_disputed=True)) == 21
    assert ("17378", "659639") not in load_ground_truth()
    print("ground_truth self-check ok")
