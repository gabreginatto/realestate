"""Round 7: crawl Coelho search result cards (code, condo, lot m2, dorms, suites, vagas, price) beyond the per-condo searches.

Usage: python scripts/r7_coelho_inventory.py OUT.json "<query string>" [--max-pages N]
Polite: CRAWL_DELAY seconds between requests (default 2), curl with a normal UA. The search page is server-rendered,
each page carries ~20 cards and the text "N imóveis encontrados".
"""
import argparse
import json
import re
import subprocess
import time
from pathlib import Path

HOST = "https://www.coelhodafonseca.com.br"
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124 Safari/537.36"


def fetch(url, tries=3):
    for i in range(tries):
        r = subprocess.run(["curl", "-sL", "--max-time", "60", "-A", UA, url], capture_output=True, text=True)
        if r.returncode == 0 and "imóveis encontrados" in r.stdout:
            return r.stdout
        time.sleep(5 * (i + 1))
    raise RuntimeError(f"fetch failed {url}")


def parse_cards(html):
    cards = {}
    hrefs = list(re.finditer(r'href="(/[^"?]*?-cf(\d{5,9}))[^"]*"', html))
    # one card spans from its first link to the first link of the next distinct code
    bounds = []
    seen = set()
    for m in hrefs:
        if m.group(2) not in seen:
            seen.add(m.group(2))
            bounds.append(m)
    for i, m in enumerate(bounds):
        end = bounds[i + 1].start() if i + 1 < len(bounds) else len(html)
        txt = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "|", html[m.start():end]))
        cells = [c.strip() for c in txt.split("|") if c.strip()]
        d = {"code": m.group(2), "url": HOST + m.group(1), "city": m.group(1).split("/")[1], "cells": cells[:30]}
        d["kind"] = next((c for c in cells if c.startswith(("Casa", "Apartamento", "Terreno", "Cobertura", "Sobrado", "Fazenda", "Sítio", "Loja", "Sala", "Galpão", "Flat", "Duplex", "Prédio", "Chácara"))), None)
        if "COD" in cells:
            j = cells.index("COD")
            d["condo"] = cells[j + 2] if j + 2 < len(cells) and not cells[j + 2].endswith(("m²", "dorms", "suítes", "vagas")) else None
        num = lambda suf: next((int(re.sub(r"\D", "", c)) for c in cells if c.endswith(suf) and re.sub(r"\D", "", c)), None)  # noqa: E731
        d["area_m2"] = num("m²")
        d["beds"], d["suites"], d["vagas"] = num("dorms"), num("suítes"), num("vagas")
        pr = next((c for c in cells if c.startswith("R$")), None)
        d["price"] = int(re.sub(r"\D", "", pr)) if pr and re.sub(r"\D", "", pr) else None
        d["transaction"] = "comprar" if "transaction=comprar" in html[m.start():m.start() + 400] or "Venda" in cells else None
        cards[d["code"]] = d
    return cards


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("out", type=Path)
    ap.add_argument("query")
    ap.add_argument("--max-pages", type=int, default=200)
    ap.add_argument("--delay", type=float, default=2.0)
    a = ap.parse_args()
    allc, declared, pages = {}, None, 0
    for p in range(1, a.max_pages + 1):
        html = fetch(f"{HOST}/search?{a.query}" + (f"&page={p}" if p > 1 else ""))
        m = re.search(r"(\d+) imóveis encontrados", html)
        declared = int(m.group(1)) if m else declared
        new = {k: v for k, v in parse_cards(html).items() if k not in allc}
        pages = p
        if not new:
            break
        allc.update(new)
        print(f"page {p}: +{len(new)} total {len(allc)}/{declared}", flush=True)
        if declared and len(allc) >= declared:
            break
        time.sleep(a.delay)
    a.out.write_text(json.dumps({"query": a.query, "declared": declared, "pages": pages, "cards": list(allc.values())}, ensure_ascii=False, indent=0))
    print(f"done {len(allc)} cards / declared {declared}")


if __name__ == "__main__":
    main()
