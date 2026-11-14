"""Controlla che le schede in docs/content puntino a strutture e rilievi esistenti. Uso: python tools/check_content.py"""
import json
from pathlib import Path

WEB = Path(__file__).resolve().parent.parent / "docs"
for region in json.loads((WEB / "data" / "index.json").read_text(encoding="utf-8")):
    rid = region["id"]
    data = json.loads((WEB / "data" / f"{rid}.json").read_text(encoding="utf-8"))
    path = WEB / "content" / f"{rid}.json"
    content = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    cs, cl = content.get("structures", {}), content.get("landmarks", {})
    marks = {l["id"] for l in data["landmarks"]}
    nodes = {**data["nodes"], **{k: v for k, v in cs.items() if v.get("tipo") == "gruppo"}}  # le schede possono aggiungere gruppi
    orphans = [k for k in cs if k not in nodes] + [k for k in cl if k not in marks]
    assert not orphans, f"{rid}: schede senza struttura o rilievo corrispondente: {orphans}"
    bad = [k for k, v in cs.items() if v.get("parent") and v["parent"] not in nodes]
    assert not bad, f"{rid}: parent inesistente per {bad}"
    assert all(v.get("testo") for v in cl.values()), f"{rid}: rilievo senza testo"
    leaves = [k for k, v in data["nodes"].items() if v["tipo"] != "gruppo"]
    done = sum(1 for k in leaves if cs.get(k, {}).get("testo"))
    print(f"{rid}: schede strutture {done}/{len(leaves)}, rilievi {len(cl)}/{len(marks)}")
