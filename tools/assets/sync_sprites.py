#!/usr/bin/env python3
"""Sync official TCG energy icons and 2D Pokémon pixel sprites into public/assets/.

Usage:
    python tools/assets/sync_sprites.py

Sources:
  - Energy orbs (grass..fairy): 52Poké MediaWiki File:*_TCG.png (authentic glossy orbs)
  - Trainer ball icon: Pokésprite items/ball/poke.png
  - Pokémon 2D pixel sprites: Pokésprite Gen 8 (classic full-body 2D box sprites)
    with fallback to Limitless TCG Pocket R2 (Gen 9 + Legends Z-A Megas).
All Pokémon sprites are tight-cropped via Pillow so pixel art aligns consistently
beside deck titles across both desktop and mobile viewports.
"""

from __future__ import annotations

import concurrent.futures
import json
import os
import re
import sys
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
CARDS_PATH = ROOT / "public" / "data" / "cards.json"
ENERGY_DIR = ROOT / "public" / "assets" / "energy"
POKEMON_DIR = ROOT / "public" / "assets" / "pokemon"
MANIFEST_PATH = ROOT / "public" / "data" / "sprites.json"

UA = "PocketLabAssetSync/1.0 (+https://github.com/RoGent-Z/ptcgp-deck-lab)"

ENERGY_WIKI_FILES = {
    "grass": "File:草_TCG.png",
    "fire": "File:火_TCG.png",
    "water": "File:水_TCG.png",
    "lightning": "File:雷_TCG.png",
    "psychic": "File:超_TCG.png",
    "fighting": "File:斗_TCG.png",
    "darkness": "File:恶_TCG.png",
    "metal": "File:钢_TCG.png",
    "dragon": "File:龙_TCG.png",
    "colorless": "File:无色_TCG.png",
    "fairy": "File:妖_TCG.png",
}

ALIASES = {
    "clodsire-paldea": "clodsire",
    "basculegion-hisui": "basculegion",
    "perrserker-galar": "perrserker",
    "obstagoon-galar": "obstagoon",
    "mr-rime-galar": "mr-rime",
    "cursola-galar": "cursola",
    "basculin-hisui": "basculin-white-striped",
    "single-strike-urshifu": "urshifu",
    "rapid-strike-urshifu": "urshifu-rapid-strike",
    "cornerstone-mask-ogerpon": "ogerpon-cornerstone",
    "hearthflame-mask-ogerpon": "ogerpon-hearthflame",
    "wellspring-mask-ogerpon": "ogerpon-wellspring",
    "teal-mask-ogerpon": "ogerpon",
    "tauros-paldea": "tauros-paldea-combat",
    "flabebe": "flabebe",
}

# Limitless R2 uses `tauros-paldea` instead of `tauros-paldea-combat`
R2_ALIASES = {
    "tauros-paldea-combat": "tauros-paldea",
}


def to_ascii_slug(s: str) -> str:
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode("ascii")
    s = s.lower().strip()
    s = s.replace("'", "").replace(".", "").replace(":", "")
    s = re.sub(r"\s+", "-", s)
    return re.sub(r"-+", "-", s).strip("-")


def normalize_species_slug(name_en: str) -> str:
    n = (name_en or "").strip()
    n = re.sub(r"\s+(?:ex|EX)$", "", n).strip()
    n = re.sub(r"^Team Rocket's\s+", "", n).strip()
    n = re.sub(r"^Detective\s+", "", n).strip()
    n = n.replace("♀", "-f").replace("♂", "-m")

    m_reg = re.match(r"^(Alolan|Galarian|Hisuian|Paldean)\s+(.+)$", n)
    if m_reg:
        reg_map = {"Alolan": "alola", "Galarian": "galar", "Hisuian": "hisui", "Paldean": "paldea"}
        slug = f"{normalize_species_slug(m_reg.group(2))}-{reg_map[m_reg.group(1)]}"
        return ALIASES.get(slug, slug)

    m_mega = re.match(r"^Mega\s+(.+?)(?:\s+([XY]))?$", n)
    if m_mega:
        suf = ("-" + m_mega.group(2).lower()) if m_mega.group(2) else ""
        slug = f"{normalize_species_slug(m_mega.group(1))}-mega{suf}"
        return ALIASES.get(slug, slug)

    m_orig = re.match(r"^Origin Forme\s+(.+)$", n)
    if m_orig:
        return f"{normalize_species_slug(m_orig.group(1))}-origin"

    for rot in ["Wash", "Heat", "Frost", "Fan", "Mow"]:
        if n == f"{rot} Rotom":
            return f"rotom-{rot.lower()}"

    if n == "Dawn Wings Necrozma":
        return "necrozma-dawn-wings"
    if n == "Dusk Mane Necrozma":
        return "necrozma-dusk-mane"
    if n == "Ultra Necrozma":
        return "necrozma-ultra"

    m_cast = re.match(r"^Castform\s+(\w+)\s+Form$", n)
    if m_cast:
        return f"castform-{m_cast.group(1).lower()}"

    if n.startswith("Oricorio "):
        style = re.sub(r"\s*Style$", "", n[9:]).strip().lower().replace(" ", "-")
        return f"oricorio-{style}"

    m_worm = re.match(r"^(.+?)\s+(Plant|Sandy|Trash)\s+Cloak$", n)
    if m_worm:
        return f"{to_ascii_slug(m_worm.group(1))}-{m_worm.group(2).lower()}"

    n = re.sub(r"\s+(?:Forme|Form|Mode|Cloak|Size|Mask|Style)$", "", n)
    slug = to_ascii_slug(n)
    return ALIASES.get(slug, slug)


def fetch_bytes(url: str, referer: str = "") -> bytes:
    headers = {"User-Agent": UA}
    if referer:
        headers["Referer"] = referer
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=15) as r:
        return r.read()


def trim_and_save_png(raw: bytes, out_path: Path, pad: int = 1) -> None:
    from io import BytesIO

    im = Image.open(BytesIO(raw)).convert("RGBA")
    bbox = im.getbbox()
    if bbox:
        im = im.crop(bbox)
    if pad > 0:
        canvas = Image.new("RGBA", (im.width + pad * 2, im.height + pad * 2), (0, 0, 0, 0))
        canvas.paste(im, (pad, pad))
        im = canvas
    im.save(out_path, format="PNG", optimize=True)


def sync_energy_icons() -> None:
    ENERGY_DIR.mkdir(parents=True, exist_ok=True)
    title_to_key = {v.replace("_", " "): k for k, v in ENERGY_WIKI_FILES.items()}
    params = urllib.parse.urlencode(
        {
            "action": "query",
            "titles": "|".join(ENERGY_WIKI_FILES.values()),
            "prop": "imageinfo",
            "iiprop": "url",
            "format": "json",
        }
    )
    info = json.loads(fetch_bytes("https://wiki.52poke.com/api.php?" + params).decode("utf-8"))
    pages = info.get("query", {}).get("pages", {}).values()
    downloaded = 0
    for p in pages:
        title = p.get("title", "")
        key = title_to_key.get(title) or title_to_key.get(title.replace(" ", "_"))
        if not key or "imageinfo" not in p:
            continue
        url = p["imageinfo"][0]["url"]
        out_path = ENERGY_DIR / f"{key}.png"
        if not out_path.exists():
            data = fetch_bytes(url, referer="https://wiki.52poke.com/")
            out_path.write_bytes(data)
        downloaded += 1

    # Trainer Pokéball pixel icon
    trainer_out = ENERGY_DIR / "trainer.png"
    if not trainer_out.exists():
        raw = fetch_bytes("https://raw.githubusercontent.com/msikma/pokesprite/master/items/ball/poke.png")
        trim_and_save_png(raw, trainer_out, pad=1)
    downloaded += 1
    print(f"[energy] synced {downloaded} icons into {ENERGY_DIR}")


def load_pokesprite_slugs() -> set[str]:
    raw = fetch_bytes("https://raw.githubusercontent.com/msikma/pokesprite/master/data/pokemon.json")
    ps_data = json.loads(raw.decode("utf-8"))
    ps_slugs = set()
    for info in ps_data.values():
        slug_en = info.get("slug", {}).get("eng", "")
        for form_name in info.get("gen-8", {}).get("forms", {}):
            ps_slugs.add(slug_en if form_name == "$" else f"{slug_en}-{form_name}")
    return ps_slugs


def sync_pokemon_sprites() -> dict:
    POKEMON_DIR.mkdir(parents=True, exist_ok=True)
    cards_raw = json.loads(CARDS_PATH.read_text(encoding="utf-8"))
    cards = cards_raw["cards"] if isinstance(cards_raw, dict) else cards_raw
    pkm_cards = [c for c in cards if c.get("type") == "pokemon"]

    slugs_needed = set()
    by_name_en = {}
    for c in pkm_cards:
        raw_en = c.get("limitName") or c.get("nameEn") or ""
        slug = normalize_species_slug(raw_en)
        if slug:
            slugs_needed.add(slug)
            by_name_en[raw_en] = slug

    ps_slugs = load_pokesprite_slugs()
    sorted_slugs = sorted(slugs_needed)

    def fetch_one(slug: str) -> tuple[str, str]:
        out_path = POKEMON_DIR / f"{slug}.png"
        if out_path.exists() and out_path.stat().st_size > 100:
            return (slug, "cached")
        candidates = []
        if slug in ps_slugs:
            candidates.append(
                (f"https://raw.githubusercontent.com/msikma/pokesprite/master/pokemon-gen8/regular/{slug}.png", "pokesprite")
            )
        r2_slug = R2_ALIASES.get(slug, slug)
        candidates.append((f"https://r2.limitlesstcg.net/pokemon/gen9/{r2_slug}.png", "limitless-r2"))

        last_err = ""
        for url, src in candidates:
            try:
                raw = fetch_bytes(url)
                trim_and_save_png(raw, out_path, pad=1)
                return (slug, src)
            except Exception as ex:
                last_err = str(ex)
        return (slug, f"ERR:{last_err}")

    stats = {"cached": 0, "pokesprite": 0, "limitless-r2": 0, "errors": []}
    with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
        for slug, res in pool.map(fetch_one, sorted_slugs):
            if res.startswith("ERR:"):
                stats["errors"].append((slug, res))
            else:
                stats[res] += 1

    print(
        f"[pokemon] total={len(sorted_slugs)} cached={stats['cached']} "
        f"pokesprite={stats['pokesprite']} r2={stats['limitless-r2']} errors={len(stats['errors'])}"
    )
    if stats["errors"]:
        for slug, err in stats["errors"][:20]:
            print("  MISS:", slug, err)

    MANIFEST_PATH.parent.mkdir(parents=True, exist_ok=True)
    manifest = {
        "count": len(sorted_slugs),
        "slugs": sorted_slugs,
        "byNameEn": by_name_en,
        "aliases": ALIASES,
    }
    MANIFEST_PATH.write_text(json.dumps(manifest, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    return stats


def main() -> int:
    sync_energy_icons()
    stats = sync_pokemon_sprites()
    return 1 if stats["errors"] else 0


if __name__ == "__main__":
    sys.exit(main())
