#!/usr/bin/env python3
"""Build Pokémon TCG Pocket Traditional Chinese catalog (public/data/cards.json & catalog.json).

Sources:
1. Roster & mechanical spine: flibustier/pokemon-tcg-pocket-database (MIT)
2. Traditional Chinese card names, abilities, attacks, and trainer text:
   52Poké Wiki official XML archive (52poke/mwarchiver) + live set-list revisions
   (CC BY-NC-SA 3.0, strictly rate-limited per 52Poké bot policy)
"""
from __future__ import annotations

import argparse
import datetime as dt
import gzip
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

PROJECT_ROOT = pathlib.Path(__file__).resolve().parents[2]
PUBLIC_DATA = PROJECT_ROOT / "public" / "data"
RAW_DIR = PROJECT_ROOT / "data" / "card-sources" / "raw"
DICT_DIR = pathlib.Path(__file__).resolve().parent / "dict"

USER_AGENT = "PocketDeckLab/1.0 (+https://github.com/RoGent-Z/ptcgp-deck-lab)"
FLIBUSTIER_BASE = "https://raw.githubusercontent.com/flibustier/pokemon-tcg-pocket-database/main/dist"
MWARCHIVER_API = "https://api.github.com/repos/52poke/mwarchiver/releases/latest"
OPENCC_BASE = "https://raw.githubusercontent.com/BYVoid/OpenCC/ver.1.1.9/data/dictionary"
WIKI_API = "https://wiki.52poke.com/api.php"
WIKI_PASS = "52P0KEW1K1"

# Official Traditional Chinese set names (aligned with Pokémon TCG Pocket CHT release)
SET_META = {
    "A1": ("最強的基因", "Genetic Apex", 286),
    "A1a": ("幻遊島", "Mythical Island", 86),
    "A2": ("時空激鬥", "Space-Time Smackdown", 207),
    "A2a": ("超克之光", "Triumphant Light", 96),
    "A2b": ("嗨放異彩", "Shining Revelry", 111),
    "A3": ("雙天之守護者", "Celestial Guardians", 239),
    "A3a": ("異次元危機", "Extradimensional Crisis", 103),
    "A3b": ("伊布花園", "Eevee Grove", 107),
    "A4": ("天與海的指引", "Wisdom of Sea and Sky", 241),
    "A4a": ("未知水域", "Secluded Springs", 105),
    "A4b": ("高級擴充包ex", "Deluxe Pack: ex", 379),
    "P-A": ("A系列特典卡", "Promo-A", 117),
    "B1": ("超級崛起", "Mega Rising", 331),
    "B1a": ("紅蓮烈焰", "Crimson Blaze", 103),
    "B2": ("幻夢遊行", "Fantastical Parade", 234),
    "B2a": ("帕底亞驚奇", "Paldean Wonders", 131),
    "B2b": ("超級異彩", "Mega Shine", 117),
    "B3": ("波導奏動", "Pulsing Aura", 234),
    "B3a": ("進擊悖謬", "Paradox Drive", 109),
    "B3b": ("奇蹟日常", "Everyday Wonders", 106),
    "B4": ("天空主宰", "Ruler of the Skies", 233),
    "B4a": ("火箭隊的野心", "Team Rocket’s Ambition", 110),
    "B4b": ("高級補充包MEGA", "Deluxe Pack: Mega", 429),
    "P-B": ("B系列特典卡", "Promo-B", 103),
    "SP1": ("最初的夥伴", "Special Pack: First Partners", 30),
    "C1": ("雙元融合", "Dual Fusion", 217),
    "P-C": ("C系列特典卡", "Promo-C", 13),
}

# 52Poké wiki set list pages for cross-referencing reprints & dual-types
LIVE_SET_PAGES = [
    ("C1", "雙元融合（TCGP）"),
    ("B4b", "高级补充包MEGA（TCGP）"),
    ("P-B", "B系列特典卡（TCGP）"),
    ("P-C", "C系列特典卡（TCGP）"),
]

RARITY_SYMBOL = {
    "C": "◊",
    "U": "◊◊",
    "R": "◊◊◊",
    "RR": "◊◊◊◊",
    "AR": "☆",
    "SR": "☆☆",
    "SAR": "☆☆",
    "IM": "☆☆☆",
    "UR": "♛",
    "S": "✦",
    "SSR": "✦✦",
    "AN": "AN",
}

PACK_ZH = {
    "Mewtwo": "超夢",
    "Charizard": "噴火龍",
    "Pikachu": "皮卡丘",
    "Mythical Island": "幻遊島",
    "Dialga": "帝牙盧卡",
    "Palkia": "帕路奇亞",
    "Triumphant Light": "超克之光",
    "Shining Revelry": "嗨放異彩",
    "Solgaleo": "索爾迦雷歐",
    "Lunala": "露奈雅拉",
    "Extradimensional Crisis": "異次元危機",
    "Eevee Grove": "伊布花園",
    "Ho-Oh": "鳳王",
    "Lugia": "洛奇亞",
    "Secluded Springs": "未知水域",
    "Deluxe Pack: ex": "高級擴充包ex",
    "Promo-A": "A系列特典卡",
    "Mega Blaziken": "超級火焰雞",
    "Mega Altaria": "超級七夕青鳥",
    "Mega Gyarados": "超級暴鯉龍",
    "Crimson Blaze": "紅蓮烈焰",
    "Fantastical Parade": "幻夢遊行",
    "Paldean Wonders": "帕底亞驚奇",
    "Mega Shine": "超級異彩",
    "Pulsing Aura": "波導奏動",
    "Paradox Drive": "進擊悖謬",
    "Everyday Wonders": "奇蹟日常",
    "Ruler of the Skies": "天空主宰",
    "Team Rocket’s Ambition": "火箭隊的野心",
    "Deluxe Pack: Mega": "高級補充包MEGA",
    "Promo-B": "B系列特典卡",
    "First Partners": "最初的夥伴",
    "Dual Fusion Pikachu": "雙元融合 皮卡丘",
    "Dual Fusion Mega Mewtwo X": "雙元融合 超級超夢X",
    "Promo-C": "C系列特典卡",
}

TYPE_ZH_TO_EN = {
    "草": "grass",
    "火": "fire",
    "水": "water",
    "雷": "lightning",
    "电": "lightning",
    "電": "lightning",
    "超": "psychic",
    "超能力": "psychic",
    "斗": "fighting",
    "鬥": "fighting",
    "格斗": "fighting",
    "格鬥": "fighting",
    "恶": "darkness",
    "惡": "darkness",
    "钢": "metal",
    "鋼": "metal",
    "无": "colorless",
    "無": "colorless",
    "无色": "colorless",
    "無色": "colorless",
    "龙": "dragon",
    "龍": "dragon",
    "妖": "fairy",
    "妖精": "fairy",
}

# Exact fallback glossary for cards not yet given standalone pages on 52Poké
FALLBACK_NAMES_ZH = {
    "Mega Latios ex": "超級拉帝歐斯ex",
    "Mega Medicham ex": "超級恰雷姆ex",
    "Zygarde": "基格爾德",
    "Zygarde ex": "基格爾德ex",
    "Mega Heracross ex": "超級赫拉克羅斯ex",
    "Ceruledge ex": "蒼炎刃鬼ex",
    "Mega Houndoom ex": "超級黑魯加ex",
    "Mega Garchomp ex": "超級烈咬陸鯊ex",
    "Team Rocket’s Scyther": "火箭隊的飛天螳螂",
    "Team Rocket's Scyther": "火箭隊的飛天螳螂",
    "Team Rocket’s Lapras": "火箭隊的拉普拉斯",
    "Team Rocket's Lapras": "火箭隊的拉普拉斯",
    "Team Rocket’s Wobbuffet": "火箭隊的果然翁",
    "Team Rocket's Wobbuffet": "火箭隊的果然翁",
    "Mega Mewtwo Y ex": "超級超夢Y ex",
    "Genome Converter Y": "基因轉換器Y",
    "Mega Dragonite ex": "超級快龍ex",
}


def load_opencc_tsv(path: pathlib.Path) -> dict[str, str]:
    mapping = {}
    if not path.exists():
        return mapping
    for line in path.read_text("utf8").splitlines():
        if not line or line.startswith("#"):
            continue
        cols = line.split("\t")
        if len(cols) >= 2:
            val = cols[1].split(" ")[0].strip()
            if cols[0] and val:
                mapping[cols[0]] = val
    return mapping


class ZhConverter:
    """Zero-dependency OpenCC ST + TWVariants converter (Apache 2.0)."""
    def __init__(self, dict_dir: pathlib.Path):
        dict_dir.mkdir(parents=True, exist_ok=True)
        for fname in ("STCharacters.txt", "STPhrases.txt", "TWVariants.txt"):
            p = dict_dir / fname
            if not p.exists():
                p.write_bytes(http_get(f"{OPENCC_BASE}/{fname}", timeout=20))
        self.st_char = load_opencc_tsv(dict_dir / "STCharacters.txt")
        self.st_phrase = load_opencc_tsv(dict_dir / "STPhrases.txt")
        self.tw_var = load_opencc_tsv(dict_dir / "TWVariants.txt")
        # Context overrides for Pokémon TCG terminology
        self.st_phrase.update({
            "宝可梦": "寶可夢",
            "进化": "進化",
            "备战": "備戰",
            "丢弃": "丟棄",
            "战斗场": "戰鬥場",
            "牌库": "牌庫",
            "伤害": "傷害",
            "能量区": "能量區",
            "弃牌区": "棄牌區",
            "硬币": "硬幣",
            "超梦": "超夢",
            "梦幻": "夢幻",
            "超级": "超級",
            "双元": "雙元",
            "只": "隻",
        })
        self.max_len = max((len(k) for k in self.st_phrase), default=1)
        # Do not force-change 台 to 臺 in proper nouns like 桌台市
        self.tw_var.pop("台", None)

    def to_tw(self, text: str) -> str:
        if not text:
            return ""
        # Protect adverbial 只
        s = text.replace("只可", "\uE001").replace("只要", "\uE002").replace("只能", "\uE003").replace("只有", "\uE004")
        out = []
        i = 0
        n = len(s)
        while i < n:
            matched = False
            for L in range(min(self.max_len, n - i), 1, -1):
                seg = s[i:i + L]
                if seg in self.st_phrase:
                    out.append(self.st_phrase[seg])
                    i += L
                    matched = True
                    break
            if not matched:
                ch = s[i]
                if ch == "只" and i > 0 and (s[i - 1].isdigit() or s[i - 1] in "这這该該那几幾每"):
                    ch = "隻"
                else:
                    ch = self.st_char.get(ch, ch)
                ch = self.tw_var.get(ch, ch)
                out.append(ch)
                i += 1
        res = "".join(out)
        return res.replace("\uE001", "只可").replace("\uE002", "只要").replace("\uE003", "只能").replace("\uE004", "只有")


def norm_set(s: str) -> str:
    s = (s or "").strip()
    return {
        "PROMO-A": "P-A",
        "Promo-A": "P-A",
        "PROMOA": "P-A",
        "PA": "P-A",
        "PROMO-B": "P-B",
        "Promo-B": "P-B",
        "PROMOB": "P-B",
        "PB": "P-B",
        "PROMO-C": "P-C",
        "Promo-C": "P-C",
        "PROMOC": "P-C",
        "PC": "P-C",
    }.get(s, s)


def canon_id(set_code: str, number: int | str) -> str:
    ns = norm_set(str(set_code))
    n = int(number)
    if ns == "SP1" and n < 0:
        n = 31 + n  # -3 -> 28, -2 -> 29, -1 -> 30
    return f"{ns}-{n:03d}"


def norm_en(name: str) -> str:
    s = str(name or "").replace("’", "'").replace("‘", "'").lower()
    return re.sub(r"[\s'`\-·・.,!?:;]", "", s)


def http_get(url: str, timeout: int = 25) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def ensure_raw_sources(skip_download: bool = False, refresh_archive: bool = False) -> tuple[pathlib.Path, pathlib.Path]:
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    temp_dir = pathlib.Path(os.environ.get("TEMP", "")) / "ptcgp-catalog-data"

    # Seed from local temp cache if RAW_DIR doesn't have them yet
    for fname in ("cards.extra.json", "sets.json", "rarities.json", "pages.ndjson"):
        dst = RAW_DIR / fname
        if not dst.exists() and temp_dir.exists() and (temp_dir / fname).exists():
            shutil.copy2(temp_dir / fname, dst)

    if not skip_download:
        for fname in ("cards.extra.json", "sets.json", "rarities.json"):
            dst = RAW_DIR / fname
            if refresh_archive or not dst.exists():
                print(f"Downloading {fname} from flibustier/pokemon-tcg-pocket-database...")
                dst.write_bytes(http_get(f"{FLIBUSTIER_BASE}/{fname}", timeout=30))

        pages_path = RAW_DIR / "pages.ndjson"
        if refresh_archive or not pages_path.exists():
            xml_gz = None if refresh_archive else next(RAW_DIR.glob("52poke-*.xml.gz"), None)
            if not xml_gz and not refresh_archive and temp_dir.exists():
                tmp_gz = next(temp_dir.glob("52poke-*.xml.gz"), None)
                if tmp_gz:
                    xml_gz = RAW_DIR / tmp_gz.name
                    shutil.copy2(tmp_gz, xml_gz)
            if not xml_gz:
                print("Fetching latest 52poke/mwarchiver release metadata...")
                rel = json.loads(http_get(MWARCHIVER_API).decode("utf8"))
                asset = next((a for a in rel.get("assets", []) if a["name"].endswith(".zip")), None)
                if not asset:
                    raise RuntimeError("No .zip archive asset found in 52poke/mwarchiver latest release")
                target_gz = RAW_DIR / f"52poke-{rel.get('tag_name', 'latest')}.xml.gz"
                if target_gz.exists() and pages_path.exists():
                    print(f"Archive {target_gz.name} already up to date.")
                    return RAW_DIR / "cards.extra.json", pages_path
                zip_path = RAW_DIR / asset["name"]
                print(f"Downloading {asset['name']} ({asset['size'] // (1024*1024)} MB)...")
                zip_path.write_bytes(http_get(asset["browser_download_url"], timeout=180))
                if shutil.which("bsdtar"):
                    subprocess.run(["bsdtar", "--passphrase", WIKI_PASS, "-xf", str(zip_path), "-C", str(RAW_DIR)], check=True)
                elif shutil.which("7z"):
                    subprocess.run(["7z", "x", "-y", f"-p{WIKI_PASS}", f"-o{RAW_DIR}", str(zip_path)], check=True)
                elif shutil.which("unzip"):
                    subprocess.run(["unzip", "-o", "-P", WIKI_PASS, str(zip_path), "-d", str(RAW_DIR)], check=True)
                else:
                    subprocess.run(["tar", "--passphrase", WIKI_PASS, "-xf", str(zip_path), "-C", str(RAW_DIR)], check=True)
                xml_gz = (sorted(RAW_DIR.glob("52poke-*.xml.gz")) or [None])[-1]
            extract_pages_from_xml(xml_gz, pages_path)

    return RAW_DIR / "cards.extra.json", RAW_DIR / "pages.ndjson"


def extract_pages_from_xml(xml_gz: pathlib.Path, out_ndjson: pathlib.Path) -> None:
    print(f"Extracting TCGP pages from {xml_gz.name}...")
    title_pat = re.compile(r"(?:^|\W)(?:[ABC][1-9][a-z]?|P-[ABC]|SP1|TCGP)[）)]")
    written = 0
    with gzip.open(xml_gz) as f, out_ndjson.open("w", encoding="utf8") as w:
        for _, elem in ET.iterparse(f, events=("end",)):
            if not elem.tag.endswith("}page"):
                continue
            ns = elem.tag[:-4]
            if elem.findtext(ns + "ns") == "0":
                title = elem.findtext(ns + "title") or ""
                rev_el = elem.find(ns + "revision")
                rev_id = rev_el.findtext(ns + "id") if rev_el is not None else ""
                txt = rev_el.findtext(ns + "text") if rev_el is not None else ""
                if txt and (title_pat.search(title) or "卡牌信息/header/Pocket" in txt or "训练家卡信息/header/Pocket" in txt or "TCG版本信息框/Pocket" in txt):
                    w.write(json.dumps([title, rev_id, txt], ensure_ascii=False) + "\n")
                    written += 1
            elem.clear()
    print(f"Extracted {written} pages to {out_ndjson.name}.")


# Zero-dependency nested MediaWiki template extractor
def extract_templates(text: str) -> list[tuple[str, dict[str, str], list[str]]]:
    results = []
    i = 0
    n = len(text)
    while i < n - 1:
        if text[i:i + 2] == "{{":
            depth = 1
            j = i + 2
            while j < n and depth > 0:
                if text[j:j + 2] == "{{":
                    depth += 1
                    j += 2
                elif text[j:j + 2] == "}}":
                    depth -= 1
                    j += 2
                else:
                    j += 1
            if depth == 0:
                inner = text[i + 2:j - 2]
                parsed = parse_template_body(inner)
                if parsed:
                    results.append(parsed)
                i = j
                continue
        i += 1
    return results


def split_top_level_pipes(body: str) -> list[str]:
    parts = []
    cur = []
    curly = 0
    square = 0
    i = 0
    n = len(body)
    while i < n:
        ch2 = body[i:i + 2]
        if ch2 == "{{":
            curly += 1
            cur.append(ch2)
            i += 2
        elif ch2 == "}}" and curly > 0:
            curly -= 1
            cur.append(ch2)
            i += 2
        elif ch2 == "[[":
            square += 1
            cur.append(ch2)
            i += 2
        elif ch2 == "]]" and square > 0:
            square -= 1
            cur.append(ch2)
            i += 2
        elif body[i] == "|" and curly == 0 and square == 0:
            parts.append("".join(cur))
            cur = []
            i += 1
        else:
            cur.append(body[i])
            i += 1
    parts.append("".join(cur))
    return parts


def parse_template_body(inner: str) -> tuple[str, dict[str, str], list[str]] | None:
    parts = split_top_level_pipes(inner)
    if not parts:
        return None
    name = parts[0].strip()
    named: dict[str, str] = {}
    positional: list[str] = []
    for p in parts[1:]:
        # Key=val only if '=' occurs outside nested {{...}} / [[...]]
        eq_idx = -1
        curly = 0
        square = 0
        for idx, ch in enumerate(p):
            if p[idx:idx + 2] == "{{":
                curly += 1
            elif p[idx:idx + 2] == "}}" and curly > 0:
                curly -= 1
            elif p[idx:idx + 2] == "[[":
                square += 1
            elif p[idx:idx + 2] == "]]" and square > 0:
                square -= 1
            elif ch == "=" and curly == 0 and square == 0:
                eq_idx = idx
                break
        if eq_idx >= 0:
            k = p[:eq_idx].strip()
            v = p[eq_idx + 1:].strip()
            named[k] = v
        else:
            positional.append(p.strip())
    return name, named, positional


def clean_wiki(text: str, conv: ZhConverter) -> str:
    if not text:
        return ""
    s = str(text)
    # Extract zh-hant variant from -{zh-hans:...;zh-hant:...}-
    def pick_hant(m: re.Match[str]) -> str:
        inner = m.group(1)
        hm = re.search(r"zh-hant:([^;]+)", inner)
        if hm:
            return hm.group(1)
        sm = re.search(r"zh-hans:([^;]+)", inner)
        return sm.group(1) if sm else inner
    s = re.sub(r"-\{([^}]+)\}-", pick_hant, s)
    s = re.sub(r"<ref[^>]*>.*?</ref>", "", s, flags=re.S)
    s = re.sub(r"<ref[^/]*/>", "", s)
    s = re.sub(r"<br\s*/?>", " ", s, flags=re.I)
    s = re.sub(r"<[^>]+>", "", s)
    s = re.sub(r"\{\{ex[^}]*\}\}", "ex", s)
    s = re.sub(r"\{\{e\|([^|}]+)(?:\|[^}]*)?\}\}", lambda m: f"[{conv.to_tw(m.group(1))}]", s)
    s = re.sub(r"\{\{TCG\|[^|}]+\|([^}]+)\}\}", r"\1", s)
    s = re.sub(r"\{\{TCG\|([^}]+)\}\}", r"\1", s)
    s = re.sub(r"\{\{i\|([^}]+)\}\}", r"\1", s)
    s = re.sub(r"\{\{Tt\|([^|}]+)\|[^}]*\}\}", r"\1", s)
    s = re.sub(r"\{\{[^}]+\}\}", "", s)
    s = re.sub(r"\[\[[^|\]]+\|([^\]]+)\]\]", r"\1", s)
    s = re.sub(r"\[\[([^\]]+)\]\]", r"\1", s)
    s = s.replace("'''", "").replace("''", "")
    s = re.sub(r"\s+", " ", s).strip()
    return conv.to_tw(s)


def parse_cost(raw: str) -> list[str]:
    if not raw:
        return []
    tokens = re.split(r"[|、,\s]+", raw.strip())
    out = []
    for tk in tokens:
        tk = tk.strip()
        if not tk or tk in ("0", "无", "無", "无能量", "無能量", "－", "-"):
            if tk in ("无", "無"):
                out.append("colorless")
            continue
        mapped = TYPE_ZH_TO_EN.get(tk)
        if mapped:
            out.append(mapped)
    return out


def parse_card_page(title: str, rev: str, txt: str, conv: ZhConverter) -> dict:
    tpls = extract_templates(txt)
    name_zh = ""
    header_name_zh = ""
    name_en = ""
    card_class = ""
    page_hp = None
    abilities = []
    attacks = []
    trainer_effect = ""
    exp_ids = []

    for tname, named, pos in tpls:
        if tname == "N":
            if pos:
                raw_n = re.sub(r"\{\{ex[^}]*\}\}", "", pos[0])
                name_zh = clean_wiki(raw_n, conv).replace(" ", "")
                name_zh = re.sub(r"(?:ex)+$", "ex", name_zh, flags=re.I)
            if len(pos) >= 4:
                raw_en = re.sub(r"\{\{ex[^}]*\}\}", " ex", pos[3])
                name_en = re.sub(r"<[^>]+>", "", raw_en).strip()
        elif tname in ("卡牌信息/header/Pocket", "训练家卡信息/header/Pocket"):
            card_class = named.get("class", "")
            if named.get("hp") and named["hp"].strip().isdigit():
                page_hp = int(named["hp"].strip())
            if named.get("name"):
                base = clean_wiki(named["name"], conv).replace(" ", "")
                if "ex" in card_class and not base.lower().endswith("ex"):
                    base += "ex"
                header_name_zh = re.sub(r"(?:ex)+$", "ex", base, flags=re.I)
        elif tname == "卡牌信息/power/Pocket":
            abilities.append({
                "name": clean_wiki(named.get("name", ""), conv),
                "effect": clean_wiki(named.get("ceffect") or named.get("effect") or "", conv),
            })
        elif tname == "卡牌信息/attack":
            dmg = named.get("damage", "").strip()
            dmg_p = named.get("damageP", "").strip()
            if dmg and dmg_p == "加":
                dmg += "+"
            elif dmg and dmg_p == "乘":
                dmg += "×"
            # cost in 52poke can be `|cost=草|无` so unnamed args after `|cost=` might land in pos
            cost_raw = named.get("cost", "")
            cost = parse_cost(cost_raw)
            for p in pos:
                if p in TYPE_ZH_TO_EN:
                    cost.append(TYPE_ZH_TO_EN[p])
            attacks.append({
                "name": clean_wiki(named.get("name", ""), conv),
                "cost": cost,
                "damage": dmg,
                "effect": clean_wiki(named.get("ceffect") or named.get("effect") or "", conv),
            })
        elif tname == "训练家卡信息/main":
            trainer_effect = clean_wiki(named.get("ceffect") or named.get("effect") or "", conv)
        elif tname == "ExpansionList/main/Pocket":
            icon = norm_set(named.get("icon", ""))
            no = named.get("no", "")
            m = re.match(r"^(\d+)", no)
            if icon and m:
                exp_ids.append(canon_id(icon, int(m.group(1))))

    # Prefer header_name_zh when N template carries disambiguation parens like 博士的研究（大木博士）
    final_name = header_name_zh if ("（" in name_zh and header_name_zh) else (name_zh or header_name_zh)
    if "ex" in card_class and final_name and not final_name.lower().endswith("ex"):
        final_name += "ex"

    return {
        "title": title,
        "rev": int(rev) if str(rev).isdigit() else rev,
        "nameZh": final_name,
        "nameEn": name_en,
        "hp": page_hp,
        "abilities": abilities,
        "attacks": attacks,
        "effect": trainer_effect,
        "expIds": exp_ids,
    }


def fetch_live_set_pages(conv: ZhConverter, skip_live: bool = False) -> tuple[dict[str, list[str]], dict[str, str]]:
    """Fetch key live 52Poké set pages to get exact dual-type overrides & latest reprint links."""
    dual_types: dict[str, list[str]] = {}
    set_card_links: dict[str, str] = {}
    if skip_live:
        return dual_types, set_card_links

    titles = [t for _, t in LIVE_SET_PAGES]
    u = (
        f"{WIKI_API}?action=query&prop=revisions&rvprop=ids|content&rvslots=main"
        f"&formatversion=2&format=json&redirects=1&converttitles=1&titles="
        + urllib.parse.quote("|".join(titles))
    )
    try:
        data = json.loads(http_get(u, timeout=20).decode("utf8"))
    except Exception as exc:
        print(f"Warning: live set fetch failed ({exc}), continuing with offline archive only.")
        return dual_types, set_card_links

    title_to_code = {t: code for code, t in LIVE_SET_PAGES}
    for page in data.get("query", {}).get("pages", []):
        if page.get("missing"):
            continue
        ptitle = page.get("title", "")
        set_code = title_to_code.get(ptitle)
        if not set_code:
            for c, t in LIVE_SET_PAGES:
                if t.startswith(ptitle.split("（")[0]):
                    set_code = c
                    break
        if not set_code:
            continue
        content = page["revisions"][0]["slots"]["main"]["content"]
        for tname, named, pos in extract_templates(content):
            if tname != "卡牌列表/entryp" or len(pos) < 3:
                continue
            m_no = re.match(r"^(\d+)", pos[0])
            if not m_no:
                continue
            cid = canon_id(set_code, int(m_no.group(1)))
            # Extract target card page hint {{C|name|set}} or {{TCGP|name}}
            card_link_raw = pos[1]
            cm = re.search(r"\{\{C\|([^|}]+)\|([^}]+)\}\}", card_link_raw)
            if cm:
                target_name = clean_wiki(cm.group(1), conv).replace(" ", "")
                set_card_links[cid] = f"{target_name}（{norm_set(cm.group(2))}）"
            else:
                tm = re.search(r"\{\{TCGP\|([^|}]+)", card_link_raw)
                if tm:
                    set_card_links[cid] = clean_wiki(tm.group(1), conv).replace(" ", "") + "（TCGP）"
            t1 = TYPE_ZH_TO_EN.get(pos[2].strip())
            t2 = TYPE_ZH_TO_EN.get(pos[3].strip()) if len(pos) >= 4 else None
            if t1 and t2 and t1 != t2:
                dual_types[cid] = [t1, t2]
        time.sleep(0.65)
    return dual_types, set_card_links


def main() -> int:
    parser = argparse.ArgumentParser(description="Build PTCGP CHT cards.json and catalog.json")
    parser.add_argument("--skip-download", action="store_true", help="Only use already-cached raw files")
    parser.add_argument("--skip-live-sets", action="store_true", help="Do not query live 52Poké set pages")
    parser.add_argument("--refresh-archive", action="store_true", help="Check latest 52poke/mwarchiver & roster releases")
    args = parser.parse_args()

    conv = ZhConverter(DICT_DIR)
    extra_path, pages_path = ensure_raw_sources(skip_download=args.skip_download, refresh_archive=args.refresh_archive)

    extra = json.loads(extra_path.read_text("utf8"))
    pages = [json.loads(l) for l in pages_path.read_text("utf8").splitlines() if l.strip()]

    by_id: dict[str, dict] = {}
    by_en: dict[str, dict] = {}
    by_title: dict[str, dict] = {}
    by_zh_short: dict[str, dict] = {}

    for title, rev, txt in pages:
        if "卡牌信息/" not in txt and "训练家卡信息/" not in txt:
            continue
        parsed = parse_card_page(title, rev, txt, conv)
        by_title[title] = parsed
        by_title[conv.to_tw(title)] = parsed
        if parsed["nameZh"]:
            by_zh_short.setdefault(parsed["nameZh"], parsed)
        for cid in parsed["expIds"]:
            by_id[cid] = parsed
        if parsed["nameEn"]:
            by_en.setdefault(norm_en(parsed["nameEn"]), parsed)

    dual_types, set_card_links = fetch_live_set_pages(conv, skip_live=args.skip_live_sets)

    # Also build set_card_links from offline set pages for B4b/others if live skipped
    for title, rev, txt in pages:
        if "卡牌列表/entryp" not in txt:
            continue
        # match known set title prefix
        set_code = None
        for code, (zh_n, _, _) in SET_META.items():
            if conv.to_tw(title).startswith(zh_n):
                set_code = code
                break
        if not set_code:
            continue
        for tname, named, pos in extract_templates(txt):
            if tname != "卡牌列表/entryp" or len(pos) < 4:
                continue
            m_no = re.match(r"^(\d+)", pos[0])
            if not m_no:
                continue
            cid = canon_id(set_code, int(m_no.group(1)))
            if cid not in set_card_links:
                cm = re.search(r"\{\{C\|([^|}]+)\|([^}]+)\}\}", pos[1])
                if cm:
                    set_card_links[cid] = f"{clean_wiki(cm.group(1), conv).replace(' ', '')}（{norm_set(cm.group(2))}）"
                else:
                    tm = re.search(r"\{\{TCGP\|([^|}]+)", pos[1])
                    if tm:
                        set_card_links[cid] = clean_wiki(tm.group(1), conv).replace(" ", "") + "（TCGP）"
            if cid not in dual_types:
                t1 = TYPE_ZH_TO_EN.get(pos[2].strip())
                t2 = TYPE_ZH_TO_EN.get(pos[3].strip())
                if t1 and t2 and t1 != t2:
                    dual_types[cid] = [t1, t2]

    set_order = {code: idx for idx, code in enumerate(SET_META.keys())}
    cards = []
    set_stats = {
        code: {"id": code, "name": meta[0], "nameEn": meta[1], "expected": meta[2], "count": 0, "wikiMatched": 0, "missing": []}
        for code, meta in SET_META.items()
    }

    for row in extra:
        set_code = norm_set(row["set"])
        raw_num = int(row["number"])
        num = 31 + raw_num if (set_code == "SP1" and raw_num < 0) else raw_num
        cid = canon_id(set_code, raw_num)
        en_name = row["name"].strip()

        wiki = by_id.get(cid)
        exact_print_match = wiki is not None
        if not wiki and cid in set_card_links:
            hint = set_card_links[cid]
            wiki = by_title.get(hint) or by_zh_short.get(hint.split("（")[0])
            exact_print_match = wiki is not None
        if not wiki:
            wiki = by_en.get(norm_en(en_name))

        raw_type = row.get("type", "pokemon")
        is_pokemon = raw_type == "pokemon"
        card_type = "pokemon" if is_pokemon else "trainer"
        subtype = None if is_pokemon else raw_type.lower()

        raw_stage = row.get("stage")
        if raw_stage == "basic":
            stage = "basic"
        elif raw_stage == 1:
            stage = "stage1"
        elif raw_stage == 2:
            stage = "stage2"
        else:
            stage = None

        if cid in dual_types:
            types = dual_types[cid]
        elif is_pokemon and row.get("element"):
            types = [row["element"].lower()]
        else:
            types = []

        packs_zh = [PACK_ZH.get(p, p) for p in (row.get("packs") or [])]
        rarity_code = row.get("rarity", "")
        rarity_sym = RARITY_SYMBOL.get(rarity_code, rarity_code)
        set_zh = SET_META.get(set_code, (set_code, set_code, 0))[0]

        # Only reuse wiki moves/abilities across fallback matches if HP also matches (avoids attaching A1 moves to SP1 Mew)
        moves_match = wiki and (exact_print_match or not is_pokemon or wiki.get("hp") == row.get("health"))

        if wiki and wiki["nameZh"]:
            name_zh = wiki["nameZh"]
            wiki_src = {
                "site": "52Poké",
                "title": wiki["title"],
                "revision": wiki["rev"],
                "url": "https://wiki.52poke.com/zh-hant/" + urllib.parse.quote(wiki["title"]),
                "license": "CC BY-NC-SA 3.0",
                "roster": "pokemon-tcg-pocket-database (MIT)",
            }
            if not moves_match:
                wiki_src["note"] = "同英文名匹配卡名；本印次專屬招式待 52Poké 單頁收錄"
            set_stats[set_code]["wikiMatched"] += 1
        else:
            name_zh = FALLBACK_NAMES_ZH.get(en_name, en_name)
            wiki_src = {
                "site": "pokemon-tcg-pocket-database",
                "license": "MIT",
                "note": "52Poké 尚未收錄此印刷條目，使用 MIT 骨架與繁中譯名兜底",
            }
            set_stats[set_code]["missing"].append(f"{cid} ({en_name})")

        # Ensure SP1-028..030 Mew keeps canonical 夢幻 name
        if set_code == "SP1" and num in (28, 29, 30):
            name_zh = "夢幻"

        card_obj = {
            "id": cid,
            "set": set_code,
            "setName": set_zh,
            "number": num,
            "pack": packs_zh[0] if packs_zh else set_zh,
            "packs": packs_zh,
            "name": name_zh,
            "nameEn": en_name,
            "limitName": en_name.replace("’", "'"),
            "type": card_type,
            "subtype": subtype,
            "stage": stage,
            "types": types,
            "hp": row.get("health"),
            "rarity": rarity_sym,
            "rarityCode": rarity_code,
            "weakness": row.get("weakness"),
            "retreat": row.get("retreatCost"),
            "evolvesFrom": row.get("evolvesFrom"),
            "abilities": wiki["abilities"] if (moves_match and is_pokemon) else [],
            "attacks": wiki["attacks"] if (moves_match and is_pokemon) else [],
            "effect": (wiki["effect"] if (moves_match and not is_pokemon) else "") or "",
            "legal": True,
            "playable": True,
            "source": wiki_src,
        }
        cards.append(card_obj)
        set_stats[set_code]["count"] += 1

    cards.sort(key=lambda c: (set_order.get(c["set"], 999), c["number"], c["id"]))

    # Compact missing list for sets with many unbuilt pages
    sets_out = []
    for code in SET_META:
        st = set_stats[code]
        if len(st["missing"]) > 12:
            st["missing"] = st["missing"][:8] + [f"…等共 {len(st['missing'])} 張待 52Poké 補錄"]
        sets_out.append(st)

    now_iso = dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")
    catalog_obj = {
        "schemaVersion": 1,
        "count": len(cards),
        "expectedTotal": sum(m[2] for m in SET_META.values()),
        "asOf": now_iso,
        "source": "52Poké 神奇寶貝百科 (CC BY-NC-SA 3.0) + pokemon-tcg-pocket-database (MIT)",
        "sets": sets_out,
    }

    PUBLIC_DATA.mkdir(parents=True, exist_ok=True)
    (PUBLIC_DATA / "cards.json").write_text(json.dumps(cards, ensure_ascii=False, separators=(",", ":")) + "\n", "utf8")
    (PUBLIC_DATA / "catalog.json").write_text(json.dumps(catalog_obj, ensure_ascii=False, indent=2) + "\n", "utf8")

    matched_total = sum(s["wikiMatched"] for s in sets_out)
    print(f"Generated {len(cards)} cards across {len(sets_out)} sets ({matched_total} matched to 52Poké wiki).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
