"""Esporta ossa e muscoli di Z-Anatomy, una regione per file, per il visualizzatore.

Uso (dalla radice del progetto):
  blender -b --disable-autoexec vendor/z-anatomy/Z-Anatomy/Startup.blend --python tools/export_region.py

Per ogni regione scrive docs/data/<id>.glb e docs/data/<id>.json, più docs/data/index.json.

  nodes      {id: {en, it, la, tipo, parent}}  foglie (con mesh) e gruppi (tipo "gruppo"), ad albero
  landmarks  [{id, di, en, it, la, pos}]       rilievi ossei, pos in coordinate glTF

Ogni capo muscolare resta una struttura a sé, figlia del gruppo del suo muscolo.
I rilievi esistono solo per il lato destro e per le ossa impari: in Z-Anatomy le etichette di sinistra
non hanno posizioni utilizzabili. Negli arti si esporta quindi solo il lato destro.
"""
import json, re
from pathlib import Path
import bpy

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "docs" / "data"
OUT.mkdir(parents=True, exist_ok=True)

# (id, nome, collezioni Z-Anatomy, esporta anche il lato sinistro)
REGIONS = [
    # fuori dal sistema locomotore nel trattato: muscoli dell'occhio e della lingua, denti, ossicini, cartilagini del naso
    ("testa", "Testa", ["Head"], True, r"Extra-ocular|Muscles of tongue|teeth|Incus|Malleus|Stapes|cartilage|Sinus of"),
    # laringe e faringe non sono sistema locomotore; i muscoli del dorso che salgono al collo stanno nel tronco
    ("collo", "Collo", ["Neck"], True, r"Laryngeal|Pharyngeal|cartilage|Hypaxial|Erector spinae|Transversospinal|"
     r"Spinotransversales|Interspinales"),
    # la collezione "Trunk" contiene anche collo, laringe, cintura pettorale e muscoli degli arti: il trattato li descrive altrove
    ("tronco", "Tronco", ["Trunk"], True, r"Muscles of neck|Suboccipital|Muscles of upper limb|Muscles of lower limb|"
     r"Fasciae of lower limb|pectoral girdle|Hyoid bone|(Arytenoid|Corniculate|Cricoid|Thyroid) cartilage"),
    ("arto-superiore", "Arto superiore", ["Right upper limb"], False),
    ("arto-inferiore", "Arto inferiore", ["Right lower limb", "Bones of lower limb"], False),
]
SYSTEMS = {"1: Skeletal system": "osso", "4: Muscular system": "muscolo"}
# shortcut: fasce, borse e guaine coprono i muscoli e bloccano il clic; escluse finché non hanno uno strato proprio
SKIP = re.compile(r"^(?!Tensor).*\b(bursa|bursae|sheath|sheaths|fascia|fasciae|septum)\b", re.I)
OTHER = re.compile(r"\b(retinaculum|aponeurosis|ligament|cartilage|tooth|incisor|canine|premolar|molar)\b", re.I)
LABEL = re.compile(r"\.(i|j|s|t|g|[eo]\d?[lr])$")  # etichette, linee, gruppi, aree d'inserzione

# --- nomi italiani e latini dalla Terminologia Anatomica distribuita con Z-Anatomy
ta = {}
with open(ROOT / "vendor" / "z-anatomy" / "TA2.csv", encoding="utf-8-sig") as f:
    rows = [l.strip().strip('"').split(";") for l in f if l.strip()]
h = rows[0]
EN, LA, IT = h.index("English"), h.index("Latin"), h.index("Italiano")
for r in rows[1:]:
    if len(r) > IT and r[EN].strip():
        ta.setdefault(r[EN].strip().lower(), (r[IT].strip(), r[LA].strip()))


def names(en):
    for k in (en, re.sub(r" (muscle|bone)$", "", en), en + " muscle"):
        if k.lower() in ta:
            it, la = ta[k.lower()]
            return {"en": en, "it": it or en, "la": la}
    return {"en": en, "it": en, "la": ""}


def base(o):
    return o.name.rsplit(".", 1)[0]


def side(o):
    """'r', 'l', '' (impari) oppure None se non è una struttura anatomica."""
    m = re.search(r"\.([lr])$", o.name)
    if m:
        return m.group(1)
    return None if LABEL.search(o.name) else ""


def gltf(v):  # Blender Z-su -> glTF Y-su
    return [round(v.x, 5), round(v.z, 5), round(-v.y, 5)]


def groups_of(o):
    """Catena dei gruppi .g dal più vicino alla radice, esclusa la radice del sistema."""
    chain, p = [], o.parent
    while p and p.type == "FONT" and p.name.endswith(".g"):
        chain.append(base(p))
        p = p.parent
    return chain[:-1]


def landmarks_of(o, sid):
    """Rilievi: testo .t figlio dell'osso, con una linea .j di 2 vertici che punta al rilievo."""
    out, inv = [], o.matrix_world.inverted()
    for t in o.children:
        if t.type != "FONT" or not t.name.endswith(".t") or base(t) == sid:
            continue
        line = next((c for c in t.children if c.type == "MESH" and len(c.data.vertices) >= 2), None)
        if not line:
            continue
        tp = t.matrix_world.translation
        vs = sorted((line.matrix_world @ v.co for v in line.data.vertices), key=lambda v: (v - tp).length)
        start, tip = vs[0], vs[-1]
        # molte linee si fermano prima dell'osso: si prolunga la linea fino alla superficie, altrimenti punto più vicino
        hit, loc, *_ = o.ray_cast(inv @ start, (inv @ tip - inv @ start).normalized())
        if not hit:
            hit, loc, *_ = o.closest_point_on_mesh(inv @ tip)
        out.append({"id": f"{sid}/{base(t)}", "di": sid, **names(base(t)), "pos": gltf(o.matrix_world @ loc if hit else tip)})
    return out


# --- fase 1: si calcola tutto finché la gerarchia di Z-Anatomy è intatta
regions = []
for rid, rname, rcols, both, *drop in REGIONS:
    nodes, landmarks, picked = {}, [], []
    for o in bpy.data.objects:
        cs = {c.name for c in o.users_collection}
        system = next((s for s in SYSTEMS if s in cs), None)
        s = side(o) if o.type == "MESH" else None
        if s is None or not system or not cs & set(rcols) or SKIP.search(o.name) or (s == "l" and not both):
            continue
        sid = base(o) if s else o.name
        if drop and re.search(drop[0], " < ".join([sid, *groups_of(o)])):
            continue
        parent = None
        for g in reversed(groups_of(o)):  # dalla radice in giù
            nodes.setdefault(g, {**names(g), "tipo": "gruppo", "parent": parent})
            parent = g
        tipo = "altro" if OTHER.search(sid) else SYSTEMS[system]
        nodes.setdefault(sid, {**names(sid), "tipo": tipo, "parent": parent})
        picked.append((o, sid))
        if s != "l":
            landmarks += landmarks_of(o, sid)
    regions.append((rid, rname, nodes, landmarks, picked))

# --- fase 2: una scena pulita per regione, senza genitori (le trasformazioni restano quelle di mondo)
done = set()
for rid, rname, nodes, landmarks, picked in regions:
    scene = bpy.data.scenes.new(rid)
    bpy.context.window.scene = scene
    for o, sid in picked:
        if o.name not in done:
            done.add(o.name)
            for c in list(o.children):  # etichette, linee e aree d'inserzione verrebbero esportate con il genitore
                c.parent = None
            for k in list(o.keys()):  # proprietà di Z-Anatomy inutili nel GLB
                del o[k]
            mw = o.matrix_world.copy()
            o.parent = None
            o.matrix_world = mw
            o.hide_viewport = o.hide_render = False
        o["id"] = sid
        scene.collection.objects.link(o)
        o.hide_set(False)
    bpy.ops.export_scene.gltf(
        filepath=str(OUT / f"{rid}.glb"), export_format="GLB", use_active_scene=True,
        export_extras=True, export_materials="NONE", export_apply=True, export_yup=True,
        export_animations=False, export_draco_mesh_compression_enable=True,
    )
    landmarks.sort(key=lambda l: l["id"])
    (OUT / f"{rid}.json").write_text(
        json.dumps({"nodes": dict(sorted(nodes.items())), "landmarks": landmarks}, ensure_ascii=False, indent=1),
        encoding="utf-8")
    missing = sorted({n["en"] for n in [*nodes.values(), *landmarks] if n["it"] == n["en"]})
    tipi = {t: sum(1 for n in nodes.values() if n["tipo"] == t) for t in ("osso", "muscolo", "altro", "gruppo")}
    print(f"EXPORT {rid}: {len(picked)} mesh, {tipi}, {len(landmarks)} rilievi, {len(missing)} senza nome italiano")
    print(f"SENZA ITALIANO {rid}:", "; ".join(missing))

(OUT / "index.json").write_text(
    json.dumps([{"id": r[0], "nome": r[1]} for r in regions], ensure_ascii=False, indent=1), encoding="utf-8")
