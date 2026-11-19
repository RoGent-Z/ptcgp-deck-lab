import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SEASON_ZH = {
  A1: '最強的基因',
  A1a: '幻遊島',
  A2: '時空激鬥',
  A2a: '超克之光',
  A2b: '嗨放異彩',
  A3: '雙天之守護者',
  A3a: '異次元危機',
  A3b: '伊布花園',
  A4: '天與海的指引',
  A4a: '未知水域',
  A4b: '高級擴充包ex',
  B1: '超級崛起',
  B1a: '熾熱紅蓮',
  B2: '夢幻遊行',
  B2a: '帕底亞奇蹟',
  B2b: '終極對決',
  B3b: '火箭隊的野心',
  B4: '天空主宰',
  C1: '雙元融合'
};

export function buildCardTranslator(cards = [], catalogSets = []) {
  const enToZh = new Map();
  for (const c of cards) {
    for (const key of [c?.nameEn, c?.limitName]) {
      if (!key || !c?.name) continue;
      if (!enToZh.has(key)) enToZh.set(key, c.name);
      const base = key.endsWith(' ex') ? key.slice(0, -3).trim() : '';
      const zhBase = c.name.endsWith('ex') ? c.name.slice(0, -2).trim() : '';
      if (base && zhBase && !enToZh.has(base)) enToZh.set(base, zhBase);
    }
  }
  // 補充單詞彙整（如 Other 等分類名）
  enToZh.set('Other', '其他');
  enToZh.set('Promo', '特典');

  const keys = [...enToZh.keys()].sort((a, b) => b.length - a.length);
  const seasonById = new Map();
  for (const s of catalogSets || []) {
    if (s?.id && s?.name) seasonById.set(s.id, s.name);
  }
  return { enToZh, keys, seasonById };
}

export function translateArchetypeName(nameEn, translator) {
  const raw = String(nameEn || '').trim();
  if (!raw) return raw;
  const { enToZh, keys } = translator;
  let rem = raw;
  const parts = [];

  while (rem) {
    let matched = false;
    for (const k of keys) {
      if (rem === k || rem.startsWith(k + ' ') || rem.startsWith(k + ' / ')) {
        parts.push(enToZh.get(k));
        rem = rem.slice(k.length).replace(/^[\s/]+/, '').trim();
        matched = true;
        break;
      }
    }
    if (!matched) {
      // 保留無法逐詞解析的罕見尾段以避免遺失資訊
      parts.push(rem);
      break;
    }
  }
  return parts.join(' · ') || raw;
}

export function translateSeasonName(seasonId, fallbackEn, translator) {
  return (
    translator?.seasonById?.get(seasonId) ||
    SEASON_ZH[seasonId] ||
    fallbackEn ||
    seasonId
  );
}

export function translateMetaSnapshot(snapshot, rootDir) {
  let cards = [];
  let sets = [];
  try {
    cards = JSON.parse(readFileSync(join(rootDir, 'public/data/cards.json'), 'utf8'));
  } catch {}
  try {
    sets = JSON.parse(readFileSync(join(rootDir, 'public/data/catalog.json'), 'utf8'))?.sets || [];
  } catch {}

  const translator = buildCardTranslator(cards, sets);
  return {
    ...snapshot,
    seasonName: translateSeasonName(snapshot.season, snapshot.seasonName, translator),
    entries: (snapshot.entries || []).map((entry) => {
      const nameEn = entry.nameEn || entry.name;
      return {
        ...entry,
        nameEn,
        name: translateArchetypeName(nameEn, translator)
      };
    })
  };
}
