#!/usr/bin/env python3
"""
Duplicate-aware evaluator for matcher outputs.

The old benchmark treats each confirmed Viva<->Coelho pair independently.
That is fine for one-to-one listings, but wrong when one physical property has
duplicate listing IDs on either site. This evaluator builds connected
components from the confirmed graph and reports:

- pair metrics: exact confirmed pair only
- entity-edge metrics: predicted pair is correct if both listing IDs are in the
  same confirmed component
- entity recall: confirmed property components with at least one correct
  predicted edge

Usage:
    python3 scripts/duplicate-aware-evaluator.py \
      data/auto-matches-megaloc.json data/auto-matches-geometric-rerank.json
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path


CONFIRMED_PAIRS = {
    ("17388", "354149"), ("16886", "617978"), ("16626", "597308"),
    ("13254", "356006"), ("17116", "674139"), ("5380", "467562"),
    ("16026", "674557"), ("12854", "616435"), ("13572", "653980"),
    ("16385", "663777"), ("16892", "663984"), ("14127", "663462"),
    ("2075", "502738"), ("17722", "677257"), ("17378", "659639"),
    ("7597", "358601"), ("18035", "661014"), ("14138", "660058"),
    ("16117", "628299"), ("17378", "425516"), ("12814", "682781"),
}

REJECTED_PAIRS = {
    ("6930", "395513"),  # Coelho page blank / code not found.
}


class UnionFind:
    def __init__(self):
        self.parent = {}

    def find(self, x):
        if x not in self.parent:
            self.parent[x] = x
        if self.parent[x] != x:
            self.parent[x] = self.find(self.parent[x])
        return self.parent[x]

    def union(self, a, b):
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.parent[rb] = ra


def parse_args():
    p = argparse.ArgumentParser(description="Duplicate-aware benchmark evaluator")
    p.add_argument("outputs", nargs="+")
    return p.parse_args()


def build_components():
    uf = UnionFind()
    for viva_code, coelho_code in CONFIRMED_PAIRS:
        uf.union(f"v:{viva_code}", f"c:{coelho_code}")

    components = {}
    for node in list(uf.parent):
        components.setdefault(uf.find(node), set()).add(node)
    node_to_component = {
        node: root for root, nodes in components.items() for node in nodes
    }
    return components, node_to_component


def load_matches(path: Path):
    payload = json.loads(path.read_text())
    if "review_matches" in payload:
        return payload.get("review_matches", [])
    return payload.get("matches", [])


def evaluate(matches):
    components, node_to_component = build_components()
    predicted = {(m["viva_code"], m["coelho_code"]) for m in matches}
    predicted = predicted - REJECTED_PAIRS

    pair_tp = predicted & CONFIRMED_PAIRS
    pair_fp = predicted - CONFIRMED_PAIRS
    pair_fn = CONFIRMED_PAIRS - predicted

    entity_tp = set()
    entity_fp = set()
    found_components = set()
    for viva_code, coelho_code in predicted:
        v_node = f"v:{viva_code}"
        c_node = f"c:{coelho_code}"
        if (
            v_node in node_to_component
            and c_node in node_to_component
            and node_to_component[v_node] == node_to_component[c_node]
        ):
            entity_tp.add((viva_code, coelho_code))
            found_components.add(node_to_component[v_node])
        else:
            entity_fp.add((viva_code, coelho_code))

    def metrics(tp, fp, fn):
        precision = tp / (tp + fp) if tp + fp else 0.0
        recall = tp / (tp + fn) if tp + fn else 0.0
        f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
        return {
            "tp": tp,
            "fp": fp,
            "fn": fn,
            "precision": precision,
            "recall": recall,
            "f1": f1,
        }

    entity_count = len(components)
    entity_recall = len(found_components) / entity_count if entity_count else 0.0
    return {
        "predicted": len(predicted),
        "pair": metrics(len(pair_tp), len(pair_fp), len(pair_fn)),
        "entity_edge": metrics(
            len(entity_tp),
            len(entity_fp),
            len(CONFIRMED_PAIRS) - len(entity_tp),
        ),
        "entity": {
            "found": len(found_components),
            "total": entity_count,
            "recall": entity_recall,
        },
        "rejected_predictions": sorted([list(p) for p in predicted & REJECTED_PAIRS]),
    }


def main():
    args = parse_args()
    for output in args.outputs:
        path = Path(output)
        result = evaluate(load_matches(path))
        pair = result["pair"]
        entity = result["entity_edge"]
        print(path)
        print(
            f"  pair:        TP={pair['tp']} FP={pair['fp']} "
            f"P={pair['precision']:.1%} R={pair['recall']:.1%} F1={pair['f1']:.1%}"
        )
        print(
            f"  entity-edge: TP={entity['tp']} FP={entity['fp']} "
            f"P={entity['precision']:.1%} R={entity['recall']:.1%} F1={entity['f1']:.1%}"
        )
        print(
            f"  entity recall: {result['entity']['found']}/"
            f"{result['entity']['total']} = {result['entity']['recall']:.1%}"
        )


if __name__ == "__main__":
    main()
