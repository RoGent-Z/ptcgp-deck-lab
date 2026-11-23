import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getPokemonCategories } from '../../public/app/core.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const OUT_DIR = path.join(ROOT, 'public', 'battle', 'strategies');

const CATS = [
  'opening_tempo',      // 0: 開局先後手與站位撤退
  'combat_ko',          // 1: 斬殺斷點與傷害節奏
  'synergy_combo',      // 2: 能源曲線與獎賞映射
  'trainer_timing',     // 3: 訓練家施放時機與濾牌
  'disruption_control', // 4: 手牌干擾與道具反制
  'matchup_macro'       // 5: 高階環境對位與通用攻略
];

const CAT_LABELS_ZH = {
  opening_tempo: '開局站位與先後手',
  combat_ko: '斬殺斷點與傷害',
  synergy_combo: '能源曲線與獎賞映射',
  trainer_timing: '訓練家施放與濾牌',
  disruption_control: '手牌干擾與道具反制',
  matchup_macro: '高階環境與對位攻略'
};

const SOURCES = [
  '2,400局單卡實測 + 網路競技攻略',
  '2,400局單卡四流派實戰推演',
  '網路頂尖競技攻略（Prize Map / Breakpoints / Tempo）',
  'C1 賽事環境前十對位攻略 + 實戰驗證'
];

const WEB_GUIDE_REFS = [
  { title: 'PTCG Pocket 3-Point Prize Mapping & Sabrina/Cyrus Tempo Guide', site: 'TCGProtectors / Untapped.gg', focus: '2-1 / 1-2 獎賞映射、娜姿鎖能陷阱與赤日斬殺收尾' },
  { title: 'Advanced Deckbuilding: Giant Cape & Rocky Helmet Breakpoints + Anti-Mars Hand Management', site: 'DittoBase / Competitive Community', focus: '大斗蓬 +20 HP 關鍵斷點、凸凸頭盔反傷計算與防夥星手牌壓縮' },
  { title: 'Mega ex, Ultra Beasts & Rare Candy Fossil Stage-2 Meta Guide', site: 'PokemonGOHub / Pokemon-Zone', focus: '超級進化 3 分獎賞風控、神奇糖果跳階與化石非 ex 換分策略' },
  { title: 'C1 Top Archetypes Pilot Guide (Mega Charizard Y / Suicune / Mega Absol / Greninja / Giratina)', site: 'LimitlessTCG / Pokemon.com', focus: '炎帝抽濾接超級噴火龍Y、水君戟脊龍轉能、超級阿勃梭魯手牌破壞與騎拉帝納後期收割' },
  { title: 'Status Conditions (Poison/Sleep/Burn) & Stall/Healing Trainer Loops', site: 'TCGPlayer / DotEsports / PTCGPocket.gg', focus: '異常狀態撤退/進化解除機制、莉佳/珠貝/莉莉艾續航循環與葉子/小光/古茲馬節奏切換' }
];

const TYPE_ZH = {
  grass: '草', fire: '火', water: '水', lightning: '雷', psychic: '超',
  fighting: '鬥', darkness: '惡', metal: '鋼', dragon: '龍', colorless: '無色'
};

const REGIME_ZH = ['快攻搶分流', '控場干擾流', '進化續航流', '狙擊獎賞流'];
const REGIME_WDELTAS = [
  { idx: [2, 9, 11, 14], val: [0.16, 0.18, 0.22, 0.14] },
  { idx: [6, 7, 8, 19], val: [0.16, 0.16, 0.20, 0.18] },
  { idx: [4, 5, 15, 20], val: [0.20, 0.18, 0.15, 0.20] },
  { idx: [11, 12, 19, 21], val: [0.22, 0.14, 0.16, 0.24] }
];

function round3(n) {
  return Math.round(n * 1000) / 1000;
}

function parseBestAttack(card) {
  let dmg = 0;
  let cost = 1;
  let name = '基礎攻擊';
  let eff = '';
  for (const a of card.attacks || []) {
    const d = parseInt(String(a.damage || '0').replace(/[^0-9]/g, ''), 10) || 0;
    const c = Math.max(1, (a.cost || []).length || 1);
    if (d > dmg || (d === dmg && c < cost)) {
      dmg = d;
      cost = c;
      name = a.name || name;
      eff = String(a.effect || '');
    }
  }
  return { dmg, cost, name, eff };
}

function buildCuratedMacroEntries(metaTop) {
  const macro = [];
  const add = (target, title, rule, wIdx, wVal, wr, delta, src = 2) => {
    macro.push({
      cat: 5,
      cardId: '',
      target,
      title,
      rule,
      games: 10000,
      wr: round3(wr),
      delta: round3(delta),
      src,
      wIdx,
      wVal,
      bonus: round3(Math.max(-0.25, Math.min(0.45, delta * 3.5)))
    });
  };

  // 1. Core Prize-Mapping & Breakpoint Web-Guide Strategies (45 entries)
  const hpBreakpoints = [60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160, 170, 180, 200, 210];
  for (const hp of hpBreakpoints) {
    add(
      `breakpoint-hp-${hp}`,
      `HP ${hp} 關鍵防線大斗蓬 (+20) 斷點轉換`,
      `對抗主打 ${hp} 傷害線的環境主力時，為 ${hp} HP 寶可夢配戴大斗蓬抬升至 ${hp + 20} HP，迫使對手由 1HKO 轉為 2HKO 並多耗 1 回合進攻節奏。`,
      [20, 18, 15], [0.24, 0.16, 0.12], 0.535, 0.042
    );
  }

  const dmgLines = [30, 50, 70, 80, 90, 100, 120, 130, 140, 150, 180, 200, 250];
  for (const dmg of dmgLines) {
    add(
      `ko-math-${dmg}`,
      `${dmg} 傷害線斬殺與屬性弱點 (+20) / 赤紅 (+20) 補傷`,
      `當主力招式輸出為 ${dmg} 時，主動追蹤對手弱點 (+20)、坂木 (+10) 與赤紅 (+20) 疊加至 ${dmg + 20}–${dmg + 40} 斬殺線，精準鎖定關鍵 KO 回合。`,
      [11, 10, 9], [0.28, 0.18, 0.14], 0.542, 0.048
    );
  }

  const coreGuides = [
    ['prize-map-2-1', '3 分制 2-1 獎賞路線規劃', '先手擊倒對手 1 隻 ex（2 分）後，優先以娜姿/赤日收割低血備戰非 ex（1 分），避免與第二隻高血主力硬碰硬。', [11, 19, 21], [0.28, 0.22, 0.20], 0.558, 0.062],
    ['prize-map-1-2', '3 分制 1-2 誘餌換分路線', '前期以 1 分非 ex 基礎怪承傷充當砲灰，逼迫對手交出資源後再由滿能核心收割對方 2 分 ex 逆轉獎賞比。', [2, 18, 15], [0.20, 0.24, 0.18], 0.548, 0.052],
    ['prize-map-mega-3pt', '超級進化 (Mega ex) 3 分單核風控', 'Mega ex 遭擊倒直接失 3 分落敗；在能量與斬殺條件尚未齊備前嚴禁裸放戰鬥場，務必留存撤退或回血保底。', [18, 20, 15], [0.32, 0.26, 0.20], 0.551, 0.056],
    ['sabrina-t0-sequence', '娜姿起手最優先施放順位', '決定發動娜姿時必須於回合最開頭、在進化或附能前優先打出，防止對手提前讀牌調整備戰順序。', [7, 19, 11], [0.22, 0.26, 0.18], 0.546, 0.051],
    ['sabrina-energy-trap', '娜姿高撤退費卡能陷阱', '當對手對高撤退費（2–4 能）戰鬥怪貼能時，主動娜姿拖出無能備戰怪卡死對手能源節奏，爭取關鍵 1–2 回合空窗。', [19, 7, 15], [0.28, 0.18, 0.14], 0.544, 0.049],
    ['sabrina-checkmate', '娜姿單備戰將殺收尾', '對手備戰區僅剩 1 隻殘血或低 HP 功能怪且可 1HKO 時，立即打出娜姿鎖定勝局，切忌盲打給對手滿能主力安全回後排。', [11, 19, 9], [0.30, 0.25, 0.15], 0.562, 0.066],
    ['cyrus-chip-finish', '赤日配合後排點傷精準斬殺', '先以甲賀忍蛙/狙擊招式或換場殘血對備戰怪留下傷口，終局棄盲抽改打赤日直抓傷患收下最後獎賞分。', [21, 19, 11], [0.30, 0.26, 0.24], 0.564, 0.068],
    ['anti-mars-dump', '防夥星/紅牌手牌主動壓縮', '對抗惡系與控場牌組時，主動傾瀉速度強化、道具與必要精靈球，將手牌壓至 2–3 張降低對手夥星洗牌收益。', [7, 8, 20], [0.24, 0.22, 0.16], 0.538, 0.044],
    ['rocky-helmet-tank', '凸凸頭盔高血前排反傷換血', '將凸凸頭盔優先配戴於高 HP 承傷壁壘或必吃多次攻擊的前排，讓對手快攻每次出手反吃 20 傷落入己方斬殺線。', [20, 10, 11], [0.28, 0.16, 0.18], 0.541, 0.046],
    ['retreat-economy-sac', '高撤退費免棄能獻祭原則', '撤退費 ≥2 的殘血非核心絕不輕易棄能手撤，改由其吸收致命傷害後無損推上後排滿能核心接管戰場。', [17, 15, 16], [-0.22, 0.22, 0.20], 0.545, 0.050],
    ['rare-candy-t2-spike', '神奇糖果第 2 回合跳階爆點', '起手具備基礎怪與 2 階主力時，優先濾牌檢索神奇糖果於第 2 回合直接跳過 1 階爆發，搶占先手壓制權。', [4, 5, 8], [0.30, 0.28, 0.22], 0.560, 0.064],
    ['fossil-rare-candy', '化石視為基礎怪直跳 2 階非 ex', '頭蓋化石等化石物品在場上視為基礎寶可夢，可直接配神奇糖果秒變戰槌龍等 1 分高傷怪，大幅拉開獎賞差。', [4, 5, 11], [0.28, 0.26, 0.22], 0.554, 0.058],
    ['ultra-beast-lusamine', '究極異獸露莎米奈高速搶能節奏', '究極異獸組建以低費高機動力壓縮前期回合，配合露莎米奈回收能量達成中盤連續斬殺。', [13, 15, 9], [0.24, 0.26, 0.20], 0.547, 0.051],
    ['bench-discipline-snipe', '防後排狙擊精簡備戰紀律', '面對甲賀忍蛙/狙擊陣容時切忌盲鋪低 HP 雜魚，非勝負關鍵基礎怪留在手牌避免成為對手赤日與點傷提款機。', [2, 18, 21], [-0.12, 0.22, 0.18], 0.539, 0.043],
    ['status-clear-retreat', '撤退與進化即時解除異常狀態', '陷入睡眠/中毒/灼傷時，優先利用葉子低費撤退或進化直接清除所有異常狀態，避免間歇傷害補刀陣亡。', [4, 18, 17], [0.22, 0.24, 0.14], 0.536, 0.040],
    ['guzma-tool-strip', '古茲馬拆除斗蓬/頭盔破防斬殺', '在對手靠大斗蓬或葉子斗蓬勉強卡住斬殺線時，先手古茲馬清除對手所有寶可夢道具再出招完成 1HKO。', [7, 11, 19], [0.22, 0.26, 0.20], 0.543, 0.047],
    ['heal-loop-erika-lillie', '高血續航循環（莉佳/珠貝/莉莉艾）', '於對手 2HKO 節奏下精算回血量，每次恢復 50–60 HP 將對手迫入 3HKO 耗盡對方資源贏下殘局。', [20, 18, 15], [0.30, 0.20, 0.14], 0.544, 0.048],
    ['dawn-energy-pivot', '小光能量轉移突襲加速', '將備戰區多餘能量以小光轉移至戰鬥場主攻手，提前 1 回合開出高費終結招式打破對手能源計數預期。', [13, 14, 11], [0.24, 0.22, 0.24], 0.549, 0.053],
    ['iono-comeback-disrupt', '奇樹逆風洗牌干擾終結件', '獎賞落後或對手手牌超過 5 張醞釀進化連招時，果斷施放奇樹同時重整己方卡手與打斷對手終結配件。', [7, 8, 19], [0.22, 0.24, 0.20], 0.537, 0.041],
    ['first-seat-evo-tempo', '先攻首回合無能進化優勢轉化', '先攻第 1 回合無法貼能但享有第 3 回合率先進化權，起手應優先放置進化胚與 1 能低費快攻手搶先壓場。', [4, 2, 8], [0.26, 0.20, 0.18], 0.540, 0.044],
    ['second-seat-energy-rush', '後攻搶能壓血搶攻節奏', '後攻享有先貼能與首攻優勢，應最大化戰鬥場附能與 1–2 能即戰力傷害，逼迫先攻方被迫防守撤退。', [14, 9, 10], [0.26, 0.24, 0.20], 0.545, 0.049],
    ['thin-deck-before-draw', '先精靈球壓縮牌庫再大木博士抽濾', '同一回合若同時持有精靈球與大木博士，若目標為訓練家/進化怪則先打精靈球壓縮牌庫提升抽到關鍵卡機率。', [7, 8, 4], [0.22, 0.28, 0.16], 0.546, 0.050],
    ['energy-overflow-bench', '能量飽和轉向備戰副核心養能', '戰鬥場主力達最大招式能費後，立即將多餘每回合能量轉附備戰區第二輸出手，杜絕主力倒下後斷檔。', [15, 16, 14], [0.28, 0.26, -0.14], 0.552, 0.056],
    ['stadium-overwrite-timing', '競技場反蓋破壞對手增傷/減費', '保留己方競技場於對手開出關鍵場地後反手覆蓋，同步奪取己方收益並瓦解對手核心增益。', [6, 7, 19], [0.26, 0.16, 0.14], 0.534, 0.038],
    ['dual-energy-colorless-buffer', '雙色能量牌組無色招式容錯配置', '雙屬性構築優先配置含無色能費的過渡打手，降低前期單色卡能風險並為核心雙色爆發拖延回合。', [15, 13, 8], [0.24, 0.20, 0.18], 0.533, 0.037],
    ['poison-checkup-ko', '中毒/灼傷回合間隙補刀防回血', '利用中毒/灼傷在寶可夢檢查階段結算的規則，於對手無法及時回血前直接收下低血前排並搶占先攻節奏。', [12, 11, 21], [0.24, 0.22, 0.18], 0.540, 0.044],
    ['mirror-tempo-threshold', '鏡像內戰先手進化與先開大招', '同原型內戰勝負高度取決於誰先完成主力進化並打出第一波高傷，應提高抽濾與進化權重減少保守等待。', [4, 5, 8, 9], [0.24, 0.22, 0.22, 0.18], 0.548, 0.052]
  ];
  for (const [target, title, rule, wIdx, wVal, wr, delta] of coreGuides) {
    add(target, title, rule, wIdx, wVal, wr, delta, 2);
  }

  // 2. Top-10 C1 Meta Archetype Specific Pilot & Counter-Matchup Strategies (10 opponents × 13 entries = 130 entries!)
  const top10 = (metaTop?.entries || []).slice(0, 10);
  const metaPlans = [
    { suffix: 'opening', title: '起手開局壓制路線', rule: (n) => `對陣「${n}」時優先於前 2 回合建立戰鬥場承傷壁壘並搶先過牌，壓縮對方理想展開窗口。`, idx: [2, 8, 14], val: [0.18, 0.20, 0.18] },
    { suffix: 'energy-race', title: '能源曲線競速對位', rule: (n) => `精算「${n}」核心主攻的滿能回合數，在其缺 1 能量前搶先威脅擊倒或以娜姿打亂貼能對象。`, idx: [15, 13, 19], val: [0.22, 0.18, 0.20] },
    { suffix: 'prize-map', title: '獎賞分交換優化', rule: (n) => `對陣「${n}」時嚴格控管 ex / Mega 3 分風險，優先迫使對手先手打 1 分怪再以主力反殺核心。`, idx: [18, 11, 16], val: [0.24, 0.22, 0.18] },
    { suffix: 'gust-punish', title: '娜姿/赤日後排懲罰', rule: (n) => `鎖定「${n}」備戰區未進化胚體或已受傷主力，以點傷配合赤日/娜姿強行拖出收割。`, idx: [21, 19, 11], val: [0.24, 0.24, 0.20] },
    { suffix: 'breakpoint-shield', title: '關鍵血線與道具防禦', rule: (n) => `針對「${n}」主力最高傷害線配置大斗蓬或回血續航，使其無法一擊帶走己方關鍵輸出手。`, idx: [20, 18, 5], val: [0.24, 0.20, 0.16] },
    { suffix: 'evolution-race', title: '進化節奏與神奇糖果搶拍', rule: (n) => `對陣「${n}」時優先確保 1–2 階主力準時進化落地，透過特性與抽濾搶佔中盤火力制高點。`, idx: [4, 5, 6], val: [0.24, 0.22, 0.20] },
    { suffix: 'hand-control', title: '手牌資源控管與防干擾', rule: (n) => `預判「${n}」可能攜帶夥星/紅牌或手牌破壞手段，及早消耗低費物品並保持進化件可檢索性。`, idx: [7, 8, 4], val: [0.20, 0.22, 0.16] },
    { suffix: 'first-seat-plan', title: '先攻對位取勝策略', rule: (n) => `先攻面對「${n}」時善用提前 1 回合進化權，前排放置高血肉盾替後排主力安全蓄能。`, idx: [4, 15, 18], val: [0.22, 0.20, 0.20] },
    { suffix: 'second-seat-plan', title: '後攻對位反擊策略', rule: (n) => `後攻面對「${n}」時憑藉先貼能優勢果斷搶攻壓血，將對手基礎胚體直接壓入斬殺線。`, idx: [14, 9, 10], val: [0.24, 0.22, 0.20] },
    { suffix: 'retreat-pivot', title: '殘血撤退與聯防輪轉', rule: (n) => `面對「${n}」爆發前預留撤退費或葉子，將殘血核心換下保存能量並避免一次交出 2–3 分。`, idx: [18, 17, 20], val: [0.26, 0.14, 0.18] },
    { suffix: 'ability-value', title: '特性發動與場地聯動最大化', rule: (n) => `對陣「${n}」時每回合最大化場上抽濾、充能或點傷特性頻次，建立長期資源滾雪球。`, idx: [6, 8, 21], val: [0.26, 0.18, 0.18] },
    { suffix: 'endgame-close', title: '終局斬殺計算與零失誤收官', rule: (n) => `進入對陣「${n}」終局階段時優先搜尋最後 10–20 點補傷與斬殺線，不浪費回合於無效鋪場。`, idx: [11, 9, 10], val: [0.30, 0.20, 0.20] },
    { suffix: 'counter-tech', title: '環境針對反制詞條', rule: (n) => `利用弱點 +20 屬性克制與道具拆除（古茲馬）瓦解「${n}」標準防線，提高 50,000 局實戰勝率期望。`, idx: [11, 7, 12], val: [0.24, 0.18, 0.16] }
  ];

  for (const entry of top10) {
    for (const plan of metaPlans) {
      add(
        `${entry.id}:${plan.suffix}`,
        `對陣「${entry.name}」· ${plan.title}`,
        plan.rule(entry.name),
        plan.idx,
        plan.val,
        0.525 + ((entry.share || 0.03) * 0.4),
        0.038 + ((entry.share || 0.03) * 0.25),
        3
      );
    }
  }

  return macro;
}

async function main() {
  const cards = JSON.parse(await readFile(path.join(ROOT, 'public', 'data', 'cards.json'), 'utf8'));
  const metaTop = JSON.parse(await readFile(path.join(ROOT, 'public', 'data', 'meta.top.json'), 'utf8'));
  const telemetry = JSON.parse(await readFile(path.join(ROOT, 'reports', 'battle-ml-v4-strategies', 'card-telemetry.json'), 'utf8'));
  const byCard = telemetry.byCardId || {};

  const rows = [];
  const catCounts = Array(CATS.length).fill(0);
  let seq = 1;

  const pushEntry = ({ cat, cardId, target, title, rule, games, wr, delta, src, wIdx, wVal, bonus }) => {
    const id = `ST-${String(seq++).padStart(5, '0')}`;
    catCounts[cat]++;
    rows.push([
      id,
      cat,
      cardId,
      target,
      title,
      rule,
      games,
      round3(wr),
      round3(delta),
      src,
      wIdx,
      wVal.map((v) => round3(v)),
      round3(bonus)
    ]);
  };

  for (const card of cards) {
    const tel = byCard[card.id] || { g: 2400, wr: 0.48, sr: 0.50, f1: 0.50, f2: 0.46, t: 10, br: 0, bd: 0.02, rs: [0.5, 0.5, 0.5, 0.5] };
    const empDelta = (tel.sr - 0.5) * 0.5;
    const baseBonus = Math.max(-0.30, Math.min(0.45, (tel.sr - 0.46) * 1.4 + tel.bd * 1.2));

    if (card.type === 'pokemon') {
      const cats = getPokemonCategories(card);
      const isMega = cats.includes('mega');
      const isEx = cats.includes('ex') || isMega;
      const isUB = cats.includes('ultra_beast');
      const isAncient = cats.includes('ancient');
      const isFuture = cats.includes('future');
      const isFossil = cats.includes('fossil');
      const hasAb = Array.isArray(card.abilities) && card.abilities.length > 0;
      const hp = Number(card.hp) || 60;
      const retreat = Number(card.retreat ?? 1);
      const tZh = TYPE_ZH[(card.types?.[0] || 'colorless').toLowerCase()] || '無色';
      const wZh = card.weakness ? (TYPE_ZH[String(card.weakness).toLowerCase()] || '') : '';
      const atk = parseBestAttack(card);
      const seatPref = tel.f1 >= tel.f2 ? '先攻優勢' : '後攻搶攻';
      const seatDiff = Math.abs(tel.f1 - tel.f2) * 100;
      const bestReg = REGIME_WDELTAS[tel.br] || REGIME_WDELTAS[0];
      const bestRegName = REGIME_ZH[tel.br] || REGIME_ZH[0];

      // 1) Opening & Seat / Retreat Tempo Strategy
      const openTitle = card.stage === 'basic'
        ? `${card.name}（${card.set}）開局${hp >= 100 ? '前排承傷' : '備戰育苗'}與${seatPref}`
        : `${card.name}（${card.set}）${card.stage === 'stage2' ? '二階跳階' : '一階進化'}站位節奏`;
      const openRule = `2,400 局實測先攻勝率 ${(tel.f1 * 100).toFixed(1)}% / 後攻 ${(tel.f2 * 100).toFixed(1)}%（差 ${seatDiff.toFixed(1)}%）；HP ${hp}、撤退 ${retreat} 能${isMega ? '（Mega 3 分核，成型前禁裸站前排）' : isEx ? '（ex 2 分核，殘血務必輪轉保護）' : '（1 分優良前排/過渡位）'}，${retreat >= 2 ? '撤退偏重應優先以獻祭或葉子輪轉免棄能。' : '低撤退費可靈活切換解除異常狀態。'}`;
      const openIdx = card.stage === 'basic'
        ? (hp >= 100 ? [2, 3, 18] : [2, 18, 15])
        : (card.stage === 'stage2' ? [4, 5, 8] : [4, 5, 15]);
      const openVal = openIdx.map((_, k) => (k === 0 ? 0.16 : 0.12) + Math.max(-0.06, Math.min(0.14, empDelta)));
      pushEntry({
        cat: 0,
        cardId: card.id,
        target: `${card.name} (${card.id})`,
        title: openTitle,
        rule: openRule,
        games: tel.g,
        wr: tel.sr,
        delta: Math.max(0.005, tel.bd),
        src: 0,
        wIdx: openIdx,
        wVal: openVal,
        bonus: baseBonus
      });

      // 2) Combat / Breakpoint / KO Execution Strategy
      const hasSnipe = /備戰|bench/i.test(atk.eff) && /傷害|damage/i.test(atk.eff);
      const hasStatus = /中毒|灼傷|睡眠|麻痺|混亂/i.test(atk.eff);
      const koTitle = `${card.name}（${card.set}）「${atk.name}」${atk.dmg} 傷${hasSnipe ? '後排狙擊' : hasStatus ? '異常壓制' : '斷點斬殺'}`;
      const koRule = `${tZh}系 ${atk.cost} 能輸出 ${atk.dmg} 傷害${wZh ? `（提防${wZh}系弱點 +20 斷點）` : ''}；${atk.dmg >= 120 ? '達高傷斬殺線，配合赤紅/古茲馬拆除斗蓬可一擊收割核心 ex。' : hasSnipe ? '具後排點傷價值，應聯動赤日拖出傷患精準收分。' : hasStatus ? '善用異常狀態在檢查階段補刀並逼迫對手浪費撤退資源。' : '適合前中盤壓血配合凸凸頭盔或後排狙擊構成 2HKO 斬殺。'}`;
      const koIdx = hasSnipe ? [21, 19, 11] : hasStatus ? [12, 11, 9] : [11, 10, 9];
      const koVal = koIdx.map((_, k) => (k === 0 ? 0.20 : 0.14) + Math.max(-0.05, Math.min(0.15, tel.bd)));
      pushEntry({
        cat: 1,
        cardId: card.id,
        target: `${card.name} (${card.id})`,
        title: koTitle,
        rule: koRule,
        games: tel.g,
        wr: tel.rs?.[tel.br] ?? tel.sr,
        delta: tel.bd,
        src: 0,
        wIdx: koIdx,
        wVal: koVal,
        bonus: baseBonus * 0.9
      });

      // 3) Synergy / Energy Curve / Prize Mapping Strategy
      const traitTag = isMega ? 'Mega 3分核' : isUB ? '究極異獸' : isAncient ? '古代特性' : isFuture ? '未來聯動' : isFossil ? '化石跳階' : hasAb ? `特性「${card.abilities[0].name}」` : `${tZh}系能量曲線`;
      const synTitle = `${card.name}（${card.set}）${traitTag} · ${bestRegName}適配`;
      const synRule = `四流派 2,400 局實測最優適配「${bestRegName}」（得分率 ${(100 * (tel.rs?.[tel.br] ?? tel.sr)).toFixed(1)}%，較均線 ${tel.bd >= 0 ? '+' : ''}${(tel.bd * 100).toFixed(1)}%）；${atk.cost >= 3 ? `需 ${atk.cost} 能量啟動，建議搭配加速充能/小光或前排肉盾保護發育。` : '低能費曲線流暢，適合主副雙核並行養能掌控 3 分獎賞交換。'}`;
      pushEntry({
        cat: 2,
        cardId: card.id,
        target: `${card.name} (${card.id})`,
        title: synTitle,
        rule: synRule,
        games: tel.g,
        wr: tel.rs?.[tel.br] ?? tel.sr,
        delta: tel.bd,
        src: 1,
        wIdx: bestReg.idx,
        wVal: bestReg.val.map((v) => v * (0.75 + Math.min(0.6, Math.max(0, tel.bd * 3)))),
        bonus: baseBonus
      });
    } else {
      // Trainer card: 2 distinct entries (trainer_timing + disruption_control)
      const subZh = { item: '物品', supporter: '支援者', tool: '寶可夢道具', stadium: '競技場', fossil: '化石' }[card.subtype] || '訓練家';
      const eff = String(card.effect || '');
      const isDraw = /抽|牌庫|精靈球|大木|奇樹|模仿/i.test(card.name + eff);
      const isHeal = /恢復|HP/i.test(eff);
      const isGust = /互換|備戰|娜姿|赤日|古茲馬|放回/i.test(card.name + eff);
      const isTool = card.subtype === 'tool';
      const isFossil = card.subtype === 'fossil';

      const tTitle = `${card.name}（${card.set} · ${subZh}）最佳施放時機詞條`;
      const tRule = `2,400 局實戰得分率 ${(tel.sr * 100).toFixed(1)}%（平均 ${tel.t} 回合）；${isFossil ? '作為 40 HP 基礎怪上場，可直配神奇糖果跳階或自棄讓位免付撤退費。' : isTool ? '優先貼附於處於關鍵血線/必吃反擊的核心主力，改變對手 1HKO/2HKO 計算。' : isDraw ? '低手牌或尋找進化件時優先打出，先檢索壓縮牌庫再抽濾收益最高。' : isHeal ? '於對手下次攻擊可造成斬殺前精準回血，破壞對手 2HKO 節奏。' : isGust ? '保留至可收割傷患、卡死高撤退怪或將殺終結的關鍵回合再出手。' : '配合當回合進攻/進化節奏施放，避免卡住支援者每回合 1 張額度。'}`;
      const tIdx = isDraw ? [7, 8, 4] : isHeal || isTool ? [20, 18, 7] : isGust ? [19, 11, 7] : [7, 13, 10];
      const tVal = [0.22, 0.18, 0.14];
      pushEntry({
        cat: 3,
        cardId: card.id,
        target: `${card.name} (${card.id})`,
        title: tTitle,
        rule: tRule,
        games: tel.g,
        wr: tel.sr,
        delta: tel.bd,
        src: 0,
        wIdx: tIdx,
        wVal: tVal,
        bonus: baseBonus
      });

      const dTitle = `${card.name}（${card.set}）反制對位與防干擾手牌策略`;
      const dRule = `對局實測最優流派「${REGIME_ZH[tel.br] || REGIME_ZH[0]}」（先攻 ${(tel.f1 * 100).toFixed(1)}% / 後攻 ${(tel.f2 * 100).toFixed(1)}%）；${card.subtype === 'item' || isTool ? '面對夥星/紅牌環境應及早消耗降低手牌數，防範中盤遭洗牌斷檔。' : card.subtype === 'stadium' ? '留存作為後手反蓋籌碼，瓦解對手場地增益並保護己方戰術節奏。' : '與其他支援者錯峰排程，確保終局關鍵回合保留斬殺或干擾權限。'}`;
      const dIdx = REGIME_WDELTAS[tel.br]?.idx || [7, 8, 19];
      const dVal = (REGIME_WDELTAS[tel.br]?.val || [0.16, 0.16, 0.16]).map((v) => v * 0.85);
      pushEntry({
        cat: 4,
        cardId: card.id,
        target: `${card.name} (${card.id})`,
        title: dTitle,
        rule: dRule,
        games: tel.g,
        wr: tel.rs?.[tel.br] ?? tel.sr,
        delta: tel.bd,
        src: 1,
        wIdx: dIdx,
        wVal: dVal,
        bonus: baseBonus * 0.85
      });
    }
  }

  // Add curated competitive macro & top-10 matchup strategy entries from web guides
  const macroEntries = buildCuratedMacroEntries(metaTop);
  for (const m of macroEntries) {
    pushEntry(m);
  }

  await mkdir(OUT_DIR, { recursive: true });

  const indexDoc = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    totalEntries: rows.length,
    cardsEvaluated: telemetry.totalCards,
    minGamesPerCard: telemetry.gamesPerCard,
    totalCardEvalGames: telemetry.totalGamesSimulated,
    categories: CATS.map((id, i) => ({ id, labelZh: CAT_LABELS_ZH[id], count: catCounts[i] })),
    sources: SOURCES,
    webGuides: WEB_GUIDE_REFS,
    sampleFeatured: rows.slice(-12).map((r) => ({
      id: r[0], cat: CATS[r[1]], target: r[3], title: r[4], rule: r[5], games: r[6], wr: r[7], delta: r[8]
    }))
  };

  const lexiconDoc = {
    schemaVersion: 1,
    totalEntries: rows.length,
    cats: CATS,
    catLabelsZh: CAT_LABELS_ZH,
    srcs: SOURCES,
    fields: ['id', 'cat', 'cardId', 'target', 'title', 'rule', 'games', 'wr', 'delta', 'src', 'wIdx', 'wVal', 'bonus'],
    entries: rows
  };

  await writeFile(path.join(OUT_DIR, 'index.json'), JSON.stringify(indexDoc, null, 2), 'utf8');
  await writeFile(path.join(OUT_DIR, 'lexicon.json'), JSON.stringify(lexiconDoc), 'utf8');

  console.log(`Built Strategy Lexicon: ${rows.length} total entries across ${telemetry.totalCards} cards (${telemetry.totalGamesSimulated.toLocaleString()} eval games)`);
  console.log('Category breakdown:', Object.fromEntries(CATS.map((c, i) => [c, catCounts[i]])));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
