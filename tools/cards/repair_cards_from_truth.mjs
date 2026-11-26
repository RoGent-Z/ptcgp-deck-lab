#!/usr/bin/env node
// Repair and verify all 4,577 cards in public/data/cards.json against the verified PTCG Pocket
// mechanical database (tmp/battle-build/source/database.json) & official Wiki (Limitless / 52Poké).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CARDS_PATH = path.join(ROOT, 'public/data/cards.json');
const DB_PATH = path.join(ROOT, 'tmp/battle-build/source/database.json');

const cards = JSON.parse(fs.readFileSync(CARDS_PATH, 'utf8'));
const dbArr = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));

const dbById = new Map();
for (const entry of dbArr) {
  const kind = Object.keys(entry)[0];
  const o = entry[kind];
  const m = String(o.id || '').trim().replace(/\s+/g, '-').match(/^([A-Za-z0-9-]+)-(\d+)$/);
  const cid = m ? `${m[1]}-${m[2].padStart(3, '0')}` : o.id;
  dbById.set(cid, { kind, ...o });
}

const GARBLE_RE = /「」|隨機個|隨機將張|擲次|抽張|抽出張卡|恢復HP|造成點|造\d+點傷害|基礎\|基礎|替補席|活躍寶可夢|現役寶可夢|活躍位置|活動位置|雷點能量|火點能量|水點能量|草點能量|超點能量|鬥點能量|惡點能量|鋼點能量|翻轉\d|對每個頭|後備寶可夢|除了任何前寶可夢|前寶可夢|體育場卡|治療\s*\d+\s*點來自|此攻擊|在你的回合中|治療該寶可夢|治療\s*\d+\s*點傷害|寶可夢工具|從你的.*那裡|你所有的寶可夢|擊倒時|如果出現正面|你的手牌|你以這種方式|每有一個|的攻擊傷害為|拋一枚硬幣|如果這隻寶可夢|如果你場上|對於這隻寶可夢|從你的牌組|丟棄該寶可夢的|在對手的下一個回合|在每個玩家的回合/;

const ENERGY_TOKEN_ZH = {
  G: '[草]', R: '[火]', W: '[水]', L: '[雷]',
  P: '[超]', F: '[鬥]', D: '[惡]', M: '[鋼]', C: '[無]'
};

function isCleanZh(s) {
  return Boolean(s && s.trim() && !GARBLE_RE.test(s));
}

// 1. Collect clean verified Traditional Chinese translations from existing cards.json entries
const zhByEnName = new Map();
const zhAtkTitleByEn = new Map();
const zhAtkEffByEn = new Map();
const zhAbTitleByEn = new Map();
const zhAbEffByEn = new Map();
const zhTrnEffByEn = new Map();

// Canonical Chinese name per English name (majority vote, excluding known broken matches)
const BROKEN_NAMES = new Set(['A1-006', 'A4b-107', 'A4b-127', 'P-A-066']);
const nameVotes = new Map();
for (const c of cards) {
  if (!c.nameEn || !c.name || BROKEN_NAMES.has(c.id)) continue;
  let m = nameVotes.get(c.nameEn);
  if (!m) { m = new Map(); nameVotes.set(c.nameEn, m); }
  m.set(c.name, (m.get(c.name) || 0) + 1);
}
for (const [en, m] of nameVotes) {
  zhByEnName.set(en, [...m.entries()].sort((a, b) => b[1] - a[1])[0][0]);
}

function recordVote(map, key, val) {
  if (!key || !isCleanZh(val)) return;
  let m = map.get(key);
  if (!m) { m = new Map(); map.set(key, m); }
  m.set(val.trim(), (m.get(val.trim()) || 0) + 1);
}
function pickTop(map, key) {
  const m = map.get(key);
  if (!m) return null;
  return [...m.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

for (const c of cards) {
  if (BROKEN_NAMES.has(c.id)) continue;
  const d = dbById.get(c.id);
  if (!d) continue;
  if (d.kind === 'Pokemon') {
    if (d.ability?.effect && c.abilities?.[0]) {
      recordVote(zhAbTitleByEn, d.ability.title, c.abilities[0].name);
      recordVote(zhAbEffByEn, d.ability.effect, c.abilities[0].effect);
    }
    const dbAtks = d.attacks || [];
    const zhAtks = c.attacks || [];
    if (dbAtks.length === zhAtks.length) {
      for (let i = 0; i < dbAtks.length; i++) {
        const da = dbAtks[i];
        const za = zhAtks[i];
        const zNum = parseInt(String(za.damage || '0').replace(/[^0-9]/g, ''), 10) || 0;
        if (da.fixed_damage == null || zNum === da.fixed_damage) {
          recordVote(zhAtkTitleByEn, da.title, za.name);
          if (da.effect) recordVote(zhAtkEffByEn, da.effect, za.effect);
        }
      }
    }
  } else {
    const enEff = d.effect || d.text || '';
    if (enEff) recordVote(zhTrnEffByEn, enEff, c.effect);
  }
}

// 2. Authoritative Traditional Chinese PTCG Pocket dictionary for every unique text missing/garbled
const EXACT_AB_TITLE = {
  'Boosted Evolution': '提升進化',
  'Shell Armor': '硬殼盔甲',
  'Time Recall': '時光回溯',
  'Bad Dreams': '夢魘',
  'Flame Aura': '火焰氣場',
  'Water Charge': '水流充能',
  'Future System': '未來系統',
  'Hospitality': '款待',
  'Royal Bloom': '皇家綻放',
  'Sturdy Aroma': '堅韌芳香',
  'Ignition': '點火',
  'Victory Star': '勝利之星',
  'Water Shifter': '水流變幻',
  'Ice Maker': '製冰者',
  'Miraculous Song': '神奇歌聲',
  'Generate Electricity': '造電',
  'Metal Defense': '金屬聯防',
  'Legendary Assault': '傳說進擊'
};

const EXACT_ATK_TITLE = {
  'Bug Bite': '蟲咬',
  'Slash': '劈開',
  'Dimensional Storm': '亞空裂斬',
  'Pop Out Throughout': '遍地冒出',
  'Ember Dance': '餘燼之舞',
  'Expert Splasher': '飛濺大師',
  'Find a Friend': '尋找朋友',
  'Tail Smash': '尾擊粉碎',
  'Sonic Impulse': '音速衝擊',
  'Surprise Attack': '突襲',
  'Draining Kiss': '吸取之吻',
  'Chakra Fist': '脈輪拳',
  'Stiffen': '變硬',
  'Reckless Charge': '捨身衝撞',
  'Poison Gas': '毒瓦斯',
  'Cell Storm': '細胞風暴',
  'Land Laser': '大地雷射',
  'Dynamic Horn': '爆發衝角',
  'Protect': '守住',
  'Impound': '扣押',
  'Shimmering Slash': '閃耀斬擊',
  'Call for Family': '呼叫夥伴',
  'Jeweled Gift': '寶石贈禮',
  'Confusion Wave': '混亂波',
  'Soul Shot': '靈魂射擊',
  'Energy Press': '能量壓制',
  'Puppy Pile': '幼犬疊羅漢',
  'Windup Thunder': '發條落雷',
  'Grimhound Flare': '冥犬烈焰',
  'Aqua Jet': '水流噴射',
  'Growl': '叫聲',
  'Whimsy Tackle': '任性衝撞',
  'Second Strike': '追擊',
  'Ruthless Whirlpool': '無情漩渦',
  'Rocket Frenzy': '火箭狂熱',
  'Punish': '懲罰',
  'Dark Slumber': '黑色微寐',
  'Take Down': '猛撞',
  'Linear Attack': '直線攻擊',
  'Falling Edge': '墜落之刃',
  'Leech Seed': '寄生種子',
  'Bubble': '泡沫',
  'Fury Swipes': '亂抓',
  'Ember': '火花',
  'Razor Shell': '貝殼刃',
  'Pin Missile': '飛彈針',
  'Double Kick': '二連踢',
  'Thunder Jolt': '電擊',
  'Psychic Blaster': '精神爆破',
  'Perplex': '迷惑',
  'Box of Surprises': '驚喜禮盒',
  'Thunderbolt': '十萬伏特',
  'Pester the Dizzy': '暈眩追擊',
  'Fly': '飛翔',
  'Draconic Slam': '龍之重擊',
  'Scratch': '抓',
  'Surf': '衝浪',
  'Psychic': '精神強念',
  'Tackle': '撞擊',
  'Bite': '咬住',
  'Vine Whip': '藤鞭',
  'Water Gun': '水槍',
  'Peck': '啄',
  'Pound': '拍擊',
  'Leafage': '樹葉',
  'Ram': '衝撞'
};

const EXACT_EFFECT_ZH = {
  // Abilities
  'Attacks used by your Future Pokémon cost 1 less [C] Energy.': '自己的「未來」寶可夢使用招式所需的[無]能量減少1個。',
  'Once during your turn, you may take a [W] Energy from your Energy Zone and attach it to this Pokémon.': '在自己的回合時，可使用1次。從自己的能量區抽出1個[水]能量，附於這隻寶可夢身上。',
  'Once during your turn, when you put this Pokémon from your hand onto your Bench, you may heal 20 damage from your Active [G] Pokémon.': '在自己的回合，當從手牌將這張卡放置於備戰區時，可使用1次。將自己戰鬥場的[草]寶可夢恢復20HP。',
  'This Pokémon gets +30 HP for each [G] Energy attached to it.': '這隻寶可夢身上每附有1個[草]能量，這隻寶可夢的最大HP+30。',
  'Each of your [G] Pokémon gets +20 HP.': '自己所有[草]寶可夢的最大HP+20。',
  'Once during your turn, when you play this Pokémon from your hand to evolve 1 of your Pokémon, you may take a [R] Energy from your Energy Zone and attach it to your Active [R] Pokémon.': '在自己的回合，當從手牌使出這張卡並完成進化時，可使用1次。從自己的能量區抽出1個[火]能量，附於戰鬥場的[火]寶可夢身上。',
  "Once during your turn, after you flip any coins for an attack of 1 of your [R] Pokémon, you may ignore all results of those coin flips and begin flipping those coins again. You can't use more than 1 Victory Star Ability each turn.": '在自己的回合時，可使用1次。當自己的[火]寶可夢使用招式擲硬幣後，可將該次擲硬幣的結果全部作廢並重新擲硬幣。「勝利之星」特性每回合只能使用1次。',
  'Once during your turn, you may switch your Active [W] Pokémon with 1 of your Benched Pokémon.': '在自己的回合時，可使用1次。將自己戰鬥場的[水]寶可夢與備戰寶可夢互換。',
  'Once during your turn, you may take a [W] Energy from your Energy Zone and attach it to the [W] Pokémon in the Active Spot.': '在自己的回合時，可使用1次。從自己的能量區抽出1個[水]能量，附於戰鬥場的[水]寶可夢身上。',
  'At the beginning of your turn, if this Pokémon is in the Active Spot, put a random [P] Pokémon from your deck into your hand.': '在自己的回合開始時，若這隻寶可夢在戰鬥場上，則從自己的牌庫隨機將1張[超]寶可夢卡加入手牌。',
  "As long as this Pokémon is in the Active Spot, it can evolve during your first turn or the turn you play it.": '只要這隻寶可夢在戰鬥場上，就算在自己的最初回合或者剛使出的回合，也可進化。',
  'This Pokémon takes -10 damage from attacks.': '這隻寶可夢受到招式的傷害-10點。',
  'Each of your evolved Pokémon can use any attack from its previous Evolutions. (You still need the necessary Energy to use each attack.)': '自己的所有進化寶可夢可使用各自進化前寶可夢持有的全部招式。（仍須具備使用招式所需的能量。）',
  "At the end of each turn, if your opponent's Active Pokémon is Asleep, do 20 damage to that Pokémon.": '在雙方的回合結束時，若對手的戰鬥寶可夢睡眠，則那隻寶可夢受到20點傷害。',
  "Whenever you attach a [R] Energy from your Energy Zone to this Pokémon, do 30 damage to your opponent's Active Pokémon.": '每次從自己的能量區將[火]能量附於這隻寶可夢身上時，對手的戰鬥寶可夢受到30點傷害。',
  'Once during your turn, you may take a [L] Energy from your Energy Zone and attach it to the [L] Pokémon in the Active Spot.': '在自己的回合時，可使用1次。從自己的能量區抽出1個[雷]能量，附於戰鬥場的[雷]寶可夢身上。',
  "As long as this Pokémon is in play, all of your [M] Pokémon take -20 damage from attacks from your opponent's Pokémon. This effect doesn't stack.": '只要這隻寶可夢在場上，自己所有[鋼]寶可夢受到對手的寶可夢招式的傷害-20點。這個效果不會重複疊加。',
  'Once during your turn, when you put this Pokémon from your hand onto your Bench, you may switch it with your Active Pokémon. If you do, move all of your Energy in play to this Pokémon.': '在自己的回合，當從手牌將這張卡放置於備戰區時，可使用1次。可將這隻寶可夢與戰鬥寶可夢互換。若互換，則將自己場上所有能量改附於這隻寶可夢身上。',
  "Once during your turn, when you put this Pokémon from your hand onto your Bench, you may switch out your opponent's Active Pokémon to the Bench. (Your opponent chooses the new Active Pokémon.)": '在自己的回合，當從手牌將這張卡放置於備戰區時，可使用1次。將對手的戰鬥寶可夢與備戰寶可夢互換。（由對手選擇放置於戰鬥場的寶可夢。）',
  "As long as this Pokémon is in the Active Spot, your opponent can't play any Stadium cards from their hand.": '只要這隻寶可夢在戰鬥場上，對手無法從手牌使出競技場卡。',
  "Once during your turn, if this Pokémon is in the Active Spot, you may switch out your opponent's Active Pokémon to the Bench. (Your opponent chooses the new Active Pokémon.)": '在自己的回合，若這隻寶可夢在戰鬥場上，可使用1次。將對手的戰鬥寶可夢與備戰寶可夢互換。（由對手選擇放置於戰鬥場的寶可夢。）',
  'Once during your turn, you may heal 20 damage from your Active Pokémon.': '在自己的回合時，可使用1次。將自己的戰鬥寶可夢恢復20HP。',
  'During Pokémon Checkup, heal 10 damage from each of your Pokémon.': '在寶可夢檢查時，將自己的所有寶可夢各恢復10HP。',
  "When this Pokémon is Knocked Out, flip a coin. If heads, your opponent can't get any points for it.": '當這隻寶可夢昏厥時，擲1次硬幣。若為正面，對手無法獲得分數。',
  'Once during your turn, if this Pokémon has a Pokémon Tool attached, you may heal 30 damage from 1 of your Pokémon.': '在自己的回合時，若這隻寶可夢身上附有「寶可夢道具」，可使用1次。將自己的1隻寶可夢恢復30HP。',
  'This Pokémon takes -20 damage from attacks.': '這隻寶可夢受到招式的傷害-20點。',
  'If any damage is done to this Pokémon by attacks, flip a coin. If heads, this Pokémon takes -80 damage from that attack.': '當這隻寶可夢受到招式的傷害時，擲1次硬幣。若為正面，則這隻寶可夢受到該招式的傷害-80點。',

  // Trainers & Quotes
  'Move all [P] Energy from 1 of your Benched [P] Pokémon to your Mega Mewtwo Y ex in the Active Spot.': '將自己備戰區1隻[超]寶可夢身上附有的所有[超]能量，改附於戰鬥場的「超級超夢Y ex」身上。',
  "Put 2 random cards from among Magneton, Heliolisk, and Clemont's Backpack from your deck into your hand.": '從自己的牌庫隨機將2張「三合一磁怪」「光電傘蜥」「希特隆的背包」加入手牌。',
  "Attacks used by the Future Pokémon this card is attached to do +20 damage to your opponent's Active Pokémon.": '附有這張卡的「未來」寶可夢使用的招式，對對手的戰鬥寶可夢造成的傷害+20點。',
  "Choose 1 of your Basic Pokémon in play. If you have a Stage 2 card in your hand that evolves from that Pokémon, put that card onto the Basic Pokémon to evolve it, skipping the Stage 1. You can't use this card during your first turn or on a Basic Pokémon that was put into play this turn.": '從自己的手牌選擇1張2階進化寶可夢卡，放置於自己場上可進化成那隻寶可夢的基礎寶可夢身上，跳過1階進化完成進化。（無法對自己的最初回合或剛使出的寶可夢使用。）',
  'Put a random Stage 2 Pokémon from your deck into your hand.': '從自己的牌庫隨機將1張2階進化寶可夢卡加入手牌。',
  "Once during each player's turn, that player may choose a card in their hand and switch it with a random Pokémon Tool card in their deck.": '雙方玩家在自己的回合時，各可使用1次。選擇自己的1張手牌，與自己牌庫中隨機1張「寶可夢道具」卡交換。',

  // Attacks (missing / broken / MT garbled)
  'Flip 2 coins. This attack does 30 damage for each heads. If this Pokémon has Lucky Mittens attached, flip 4 coins instead.': '擲2次硬幣，造成正面出現的次數×30點傷害。若這隻寶可夢身上附有「幸運手套」，則這個招式擲硬幣的次數改為4次。',
  'If Quick-Grow Extract is in your discard pile, this attack does 30 more damage.': '若自己的棄牌區有「速生萃取液」，則增加30點傷害。',
  "Flip a coin. If heads, discard a random Energy from your opponent's Active Pokémon.": '擲1次硬幣若為正面，則將對手的戰鬥寶可夢身上的隨機1個能量丟棄。',
  "Discard a random Energy from your opponent's Active Pokémon.": '將對手的戰鬥寶可夢身上的隨機1個能量丟棄。',
  'Discard a random Energy from this Pokémon.': '將這隻寶可夢身上的隨機1個能量丟棄。',
  'Flip 3 coins. If 1 of them is heads, this attack does 20 more damage. If 2 of them are heads, this attack does 50 more damage. If all of them are heads, this attack does 120 more damage.': '擲3次硬幣。若出現1次正面，則增加20點傷害；若出現2次正面，則增加50點傷害；若全部為正面，則增加120點傷害。',
  "If this is the first time this Pokémon has used an attack after coming into play, this attack does 20 more damage, and your opponent's Active Pokémon is now Paralyzed.": '若這隻寶可夢上場後首次使用招式，則增加20點傷害，並將對手的戰鬥寶可夢麻痺。',
  'This attack does 20 more damage for each [L] Energy attached to this Pokémon.': '這隻寶可夢身上每附有1個[雷]能量，則增加20點傷害。',
  "Your opponent's Active Pokémon is now Asleep.": '將對手的戰鬥寶可夢睡眠。',
  "Your opponent's Active Pokémon is now Burned.": '將對手的戰鬥寶可夢灼傷。',
  "Your opponent's Active Pokémon is now Poisoned.": '將對手的戰鬥寶可夢中毒。',
  "Your opponent's Active Pokémon is now Confused.": '將對手的戰鬥寶可夢混亂。',
  'Both Active Pokémon are now Confused.': '將雙方的戰鬥寶可夢混亂。',
  "Flip a coin. If heads, your opponent's Active Pokémon is now Paralyzed.": '擲1次硬幣若為正面，則將對手的戰鬥寶可夢麻痺。',
  "Flip 2 coins. If both of them are heads, discard your opponent's Active Pokémon.": '擲2次硬幣，若全部為正面，則將對手的戰鬥寶可夢丟棄。',
  "This attack does 20 more damage for each of your opponent's Benched Pokémon.": '增加對手的備戰寶可夢的數量×20點傷害。',
  'This attack also does 20 damage to each of your Benched Pokémon.': '自己的所有備戰寶可夢也各受到20點傷害。',
  "Switch in 1 of your opponent's Benched Pokémon to the Active Spot. If you do, this attack does 50 damage to the new Active Pokémon.": '選擇1隻對手的備戰寶可夢，與戰鬥寶可夢互換。若互換，則對新上場的戰鬥寶可夢造成50點傷害。',
  'Take a random Energy from among [G], [R], [W], [L], [P], [F], [D], and [M] Energy from your Energy Zone and attach it to 1 of your Benched Pokémon.': '從自己的能量區隨機抽出1個[草]、[火]、[水]、[雷]、[超]、[鬥]、[惡]或[鋼]能量，附於1隻備戰寶可夢身上。',
  "Discard an Energy from this Pokémon, and this attack also does 20 damage to each of your opponent's Benched Pokémon.": '將這隻寶可夢身上的1個能量丟棄，對手的全部備戰寶可夢也各受到20點傷害。',
  "Discard all Energy from this Pokémon. Knock Out your opponent's Active Pokémon.": '將這隻寶可夢身上的能量全部丟棄。將對手的戰鬥寶可夢氣絕。',
  'Take a [M] Energy from your Energy Zone and attach it to 1 of your Benched Pokémon.': '從自己的能量區抽出1個[鋼]能量，附於1隻備戰寶可夢身上。',
  'Choose 2 of your Benched Pokémon. For each of those Pokémon, take a [P] Energy from your Energy Zone and attach it to that Pokémon.': '選擇自己的2隻備戰寶可夢，從自己的能量區各抽出1個[超]能量並分別附於那2隻寶可夢身上。',
  "If this Pokémon and your opponent's Active Pokémon have 1 or more of the same type of Energy attached, this attack does 60 more damage.": '若這隻寶可夢與對手的戰鬥寶可夢身上附有1個以上相同屬性的能量，則增加60點傷害。',
  "If this Pokémon didn't move from the Bench to the Active Spot this turn, this attack does nothing.": '若這隻寶可夢在此回合不是從備戰區移至戰鬥場的，則這個招式失敗。',
  "1 of your opponent's Active Pokémon's attacks is chosen at random. During your opponent's next turn, that Pokémon can't use the chosen attack.": '隨機選擇對手的戰鬥寶可夢持有的1個招式。在下個對手的回合，那隻寶可夢無法使用所選的招式。',
  "If your opponent's Active Pokémon has damage on it, this attack does 60 more damage.": '若對手的戰鬥寶可夢已受到傷害，則增加60點傷害。',
  "If your opponent's Active Pokémon has damage on it, this attack does 70 more damage.": '若對手的戰鬥寶可夢已受到傷害，則增加70點傷害。',
  "If your opponent's Active Pokémon is Poisoned, this attack does 60 more damage.": '若對手的戰鬥寶可夢處於中毒狀態，則增加60點傷害。',
  "If your opponent's Active Pokémon is Confused, this attack does 90 more damage.": '若對手的戰鬥寶可夢處於混亂狀態，則增加90點傷害。',
  "1 of your opponent's Benched Pokémon is chosen at random. This attack also does 20 damage to it.": '隨機對對手的1隻備戰寶可夢也造成20點傷害。',
  "Choose 1 of your Benched Pokémon's attacks, except any Pokémon ex, and use it as this attack. If this Pokémon doesn't have the necessary Energy to use that attack, this attack does nothing.": '選擇自己備戰寶可夢（「寶可夢ex」除外）持有的1個招式，作為這個招式使用。若這隻寶可夢沒有附有該招式所需的能量，則招式失敗。',
  "This attack does 30 more damage for each Energy attached to your opponent's Active Pokémon.": '增加對手的戰鬥寶可夢身上附加的能量的數量×30點傷害。',
  "This attack does 20 more damage for each Energy attached to your opponent's Active Pokémon.": '增加對手的戰鬥寶可夢身上附加的能量的數量×20點傷害。',
  'Discard all Energy from this Pokémon.': '將這隻寶可夢身上的能量全部丟棄。',
  'Discard 2 random Energy from this Pokémon.': '將這隻寶可夢身上的隨機2個能量丟棄。',
  'Discard a [R] Energy from this Pokémon.': '將這隻寶可夢身上的1個[火]能量丟棄。',
  "Discard 3 [W] Energy from this Pokémon. This attack also does 20 damage to each of your opponent's Benched Pokémon.": '將這隻寶可夢身上的3個[水]能量丟棄，對手的所有備戰寶可夢也各受到20點傷害。',
  "1 of your opponent's Pokémon is chosen at random 3 times. For each time a Pokémon was chosen, do 50 damage to it.": '隨機選擇對手的1隻寶可夢3次，每次被選中的寶可夢受到50點傷害。',
  'Flip a coin. If tails, this attack does nothing.': '擲1次硬幣，若為反面則這個招式失敗。',
  "Flip a coin. If tails, this attack does nothing. If heads, during your opponent's next turn, prevent all damage from—and effects of—attacks done to this Pokémon.": '擲1次硬幣，若為反面則這個招式失敗。若為正面，在下個對手的回合，這隻寶可夢不會受到招式的傷害與效果的影響。',
  "Flip a coin. If heads, during your opponent's next turn, prevent all damage from—and effects of—attacks done to this Pokémon.": '擲1次硬幣若為正面，則在下個對手的回合，這隻寶可夢不會受到招式的傷害與效果的影響。',
  'If this Pokémon has damage on it, this attack does -100 damage.': '若這隻寶可夢已受到傷害，則這個招式造成的傷害-100點。',
  'Put a random Pokémon from your deck into your hand.': '從自己的牌庫隨機將1張寶可夢卡加入手牌。',
  'Put 1 random Basic Pokémon from your deck onto your Bench.': '從自己的牌庫隨機將1張基礎寶可夢卡放置於備戰區。',
  'Heal 10 damage from this Pokémon.': '將這隻寶可夢恢復10HP。',
  'Heal 20 damage from this Pokémon.': '將這隻寶可夢恢復20HP。',
  'Heal 20 damage from 1 of your Pokémon.': '將自己的1隻寶可夢恢復20HP。',
  'This Pokémon also does 10 damage to itself.': '這隻寶可夢也受到10點傷害。',
  'Flip a coin. If tails, this Pokémon also does 60 damage to itself.': '擲1次硬幣，若為反面，這隻寶可夢也受到60點傷害。',
  "During your opponent's next turn, this Pokémon takes -20 damage from attacks.": '在下個對手的回合，這隻寶可夢受到招式的傷害-20點。',
  "During your opponent's next turn, attacks used by the Defending Pokémon do -20 damage.": '在下個對手的回合，受到這個招式的寶可夢使用招式造成的傷害-20點。',
  "During your opponent's next turn, the Defending Pokémon can't retreat.": '在下個對手的回合，受到這個招式的寶可夢無法撤退。',
  "If this Pokémon has any [P] Energy attached, this attack does 40 more damage. This attack's damage isn't affected by any effects on your opponent's Active Pokémon.": '若這隻寶可夢身上附有[超]能量，則增加40點傷害。這個招式的傷害不計算對手的戰鬥寶可夢身上的附加效果。',
  'Flip 2 coins. If both of them are heads, this attack does 20 more damage.': '擲2次硬幣，若全部為正面，則增加20點傷害。',
  'Flip a coin. If heads, this attack does 30 more damage.': '擲1次硬幣若為正面，則增加30點傷害。',
  'Flip a coin for each [P] Energy attached to this Pokémon. This attack does 60 damage for each heads.': '擲與這隻寶可夢身上附有的[超]能量數量相同次數的硬幣，造成正面出現的次數×60點傷害。',
  'Discard a random Energy from among the Energy attached to all Pokémon (both yours and your opponent\'s).': '從雙方場上所有寶可夢身上附有的能量中隨機將1個能量丟棄。',
  "Discard a card from your hand. If you can't, this attack does nothing.": '將自己的1張手牌丟棄。若無法丟棄，則這個招式失敗。',
  'Reveal all of your Pokémon in play and in your hand that have the Puppy Pile attack, and this attack does 20 damage for each Pokémon you revealed in this way.': '將自己場上與手牌中所有持有「幼犬疊羅漢」招式的寶可夢給對手看過，造成展示張數×20點傷害。',
  'This attack does 30 damage for each Pokémon Tool attached to all of your Pokémon.': '造成自己所有寶可夢身上附有的「寶可夢道具」數量×30點傷害。',
  "This attack also does 10 damage to 1 of your opponent's Benched Pokémon.": '對手的1隻備戰寶可夢也受到10點傷害。',
  "If this Pokémon has more Energy attached than your opponent's Active Pokémon, this attack does 40 more damage.": '若這隻寶可夢身上附有的能量數量比對手的戰鬥寶可夢多，則增加40點傷害。',
  'Reveal the top 6 cards of your deck. This attack does 30 damage for each Pokémon you find there that has “Team Rocket” in its name. Shuffle the revealed cards back into your deck.': '翻開自己牌庫上方6張卡，造成其中名稱含有「火箭隊」的寶可夢卡張數×30點傷害。將翻開的卡放回牌庫並重洗。',
  "If your opponent's Active Pokémon has “Team Rocket” in its name, this attack does 70 more damage.": '若對手的戰鬥寶可夢名稱含有「火箭隊」，則增加70點傷害。',
  "This attack does 50 damage to 1 of your opponent's Pokémon.": '對手的1隻寶可夢受到50點傷害。',
  'Discard the top card of your deck, and if that card is an Item, this attack does 20 more damage.': '將自己牌庫上方1張卡丟棄，若該卡為物品卡，則增加20點傷害。',
  'You may move any amount of Energy from your Pokémon in play to your other Pokémon in any way you like.': '可將自己場上寶可夢身上附有的任意數量能量，隨意改附於自己的其他寶可夢身上。',
  "Flip a coin. If heads, this attack does 70 damage to your opponent's Active Pokémon. If tails, heal 30 damage from your opponent's Active Pokémon.": '擲1次硬幣。若為正面，對對手的戰鬥寶可夢造成70點傷害；若為反面，將對手的戰鬥寶可夢恢復30HP。',
  'This attack also does 20 damage to 1 of your Pokémon.': '自己的1隻寶可夢也受到20點傷害。',
  'If your opponent has exactly 2, 4, or 6 cards in their hand, this attack does 40 more damage.': '若對手的手牌為2張、4張或6張，則增加40點傷害。',
  'Draw a card.': '從自己的牌庫抽出1張卡。',
  "This attack is used twice in a row. The second attack does 40 damage.(If the first attack Knocks Out your opponent's Active Pokémon, the second attack is used after your opponent chooses a new Active Pokémon.)": '這個招式會連續使用2次。第2次造成40點傷害。（若對手的戰鬥寶可夢因第1次招式而昏厥，則在對手放置新的戰鬥寶可夢後，使用第2次。）',
  "If your opponent's Active Pokémon is a Pokémon ex, this attack does 40 more damage.": '若對手的戰鬥寶可夢為「寶可夢ex」，則增加40點傷害。',
  'If this Pokémon has a Pokémon Tool attached, this attack does 40 more damage.': '若這隻寶可夢身上附有「寶可夢道具」，則增加40點傷害。',
  'If this Pokémon has a Pokémon Tool attached, this attack does 20 more damage.': '若這隻寶可夢身上附有「寶可夢道具」，則增加20點傷害。',
  'If this Pokémon evolved from Sneasel during this turn, this attack does 20 more damage.': '若這隻寶可夢在此回合從「狃拉」進化而來，則增加20點傷害。',
  'This attack does 40 more damage for each time your Pokémon have been Knocked Out during this game.': '這場對戰中自己的寶可夢每昏厥1次，則增加40點傷害。',
  "Discard 2 Energy from this Pokémon. During your opponent's next turn, this Pokémon takes -30 damage from attacks.": '將這隻寶可夢身上的2個能量丟棄。在下個對手的回合，這隻寶可夢受到招式的傷害-30點。',
  'This attack does 20 more damage for each type of Energy attached to this Pokémon.': '這隻寶可夢身上每附有1種屬性的能量，則增加20點傷害。',
  'If you have 4 or more [L] Energy in play, this attack does 70 more damage.': '若自己場上的[雷]能量有4個以上，則增加70點傷害。',
  'Flip a coin. If heads, this attack does 50 more damage. If tails, this Pokémon also does 50 damage to itself.': '擲1次硬幣。若為正面，則增加50點傷害；若為反面，這隻寶可夢也受到50點傷害。',
  'This attack does 40 damage for each Pokémon Tool attached to all of your Pokémon.': '造成自己所有寶可夢身上附有的「寶可夢道具」數量×40點傷害。',
  'This attack does 20 more damage for each [P] Energy attached to all of your Pokémon.': '自己所有寶可夢身上每附有1個[超]能量，則增加20點傷害。',
  'This attack does 20 more damage for each Pokémon in your discard pile.': '自己的棄牌區每有1張寶可夢卡，則增加20點傷害。',
  'Discard Water2 [W] Energy from this Pokémon. Your opponent\'s Active Pokémon is now Paralyzed.': '將這隻寶可夢身上的2個[水]能量丟棄。將對手的戰鬥寶可夢麻痺。',
  "If this Pokémon evolved from Dunsparce during this turn, discard 2 random Energy from your opponent's Active Pokémon.": '若這隻寶可夢在此回合從「土龍弟弟」進化而來，則將對手的戰鬥寶可夢身上的隨機2個能量丟棄。',
  "Flip a coin. If heads, the Defending Pokémon can't attack during your opponent's next turn.": '擲1次硬幣若為正面，則在下個對手的回合，受到這個招式的寶可夢無法使用招式。',
  'Put a random Item card from your discard pile into your hand.': '從自己的棄牌區隨機將1張物品卡加入手牌。'
};

function translateEnglishEffectFallback(en) {
  if (!en) return '';
  if (EXACT_EFFECT_ZH[en]) return EXACT_EFFECT_ZH[en];
  const existing = pickTop(zhAtkEffByEn, en) || pickTop(zhAbEffByEn, en) || pickTop(zhTrnEffByEn, en);
  if (existing) return existing;

  // Parametric exact translations for coin-flip patterns
  let m;
  if ((m = en.match(/^Flip (\d+) coins\. This attack does (\d+) damage for each heads\.$/))) {
    return `擲${m[1]}次硬幣，造成正面出現的次數×${m[2]}點傷害。`;
  }
  if ((m = en.match(/^Flip (\d+) coins\. This attack does (\d+) more damage for each heads\.$/))) {
    return `擲${m[1]}次硬幣，增加正面出現的次數×${m[2]}點傷害。`;
  }
  if ((m = en.match(/^Flip a coin\. If heads, this attack does (\d+) more damage\.$/))) {
    return `擲1次硬幣若為正面，則增加${m[1]}點傷害。`;
  }
  return null;
}

function formatDamageStr(da) {
  const eff = String(da.effect || '');
  const base = Number(da.fixed_damage || 0);
  if (base === 0) {
    // Check pure × scaling (Flip N coins -> "20×", etc.)
    const mx = eff.match(/(?:This attack does|do) (\d+) damage for each/i);
    if (mx && !/more damage/i.test(eff)) return `${mx[1]}×`;
    return '';
  }
  if (/more damage|for each/i.test(eff)) return `${base}+`;
  if (/does -(\d+) damage|does −(\d+) damage/i.test(eff)) return `${base}-`;
  return String(base);
}

let fixedNames = 0, fixedCosts = 0, fixedAttacks = 0, fixedAbilities = 0, fixedTrainers = 0, fixedGarble = 0;

for (const c of cards) {
  // Handle SP1-028/029/030 RGB Mew (verified via Serebii / Bulbapedia / Pokemon Zone)
  if (c.id === 'SP1-028' || c.id === 'SP1-029' || c.id === 'SP1-030') {
    if (!c.attacks?.length) {
      c.attacks = [{
        name: '精神強念',
        cost: ['psychic', 'colorless'],
        damage: '30+',
        effect: '增加對手的戰鬥寶可夢身上附加的能量的數量×20點傷害。'
      }];
      fixedAttacks++;
    }
    continue;
  }

  const d = dbById.get(c.id);
  if (!d) continue;

  // Fix completely wrong Pokémon names (4 broken 52Poké matches + typo)
  if (BROKEN_NAMES.has(c.id)) {
    const rightName = zhByEnName.get(c.nameEn);
    if (rightName && c.name !== rightName) {
      c.name = rightName;
      fixedNames++;
    }
  } else if (c.id === 'B3-154' && c.name === '古老斗技場') {
    c.name = '古老鬥技場';
    fixedNames++;
  }

  if (d.kind === 'Pokemon') {
    // Sync HP from verified DB
    if (d.hp && Number(c.hp) !== Number(d.hp)) c.hp = Number(d.hp);

    // Sync Ability
    if (d.ability?.effect) {
      const zhAb = c.abilities?.[0];
      const needAbFix = !zhAb || !isCleanZh(zhAb.effect) || BROKEN_NAMES.has(c.id);
      if (needAbFix) {
        const abTitle = (zhAb?.name && !BROKEN_NAMES.has(c.id) ? zhAb.name : null)
          || EXACT_AB_TITLE[d.ability.title]
          || pickTop(zhAbTitleByEn, d.ability.title)
          || d.ability.title;
        const abEff = translateEnglishEffectFallback(d.ability.effect);
        if (!abEff) throw Error(`Missing CHT ability translation for ${c.id} (${d.ability.title}): ${d.ability.effect}`);
        c.abilities = [{ name: abTitle, effect: abEff }];
        fixedAbilities++;
      }
    } else if (c.abilities?.length > 0 && !d.ability) {
      // Remove phantom ability from wrong 52Poké page match (e.g. P-B-094 Meowstic)
      c.abilities = [];
      fixedAbilities++;
    }

    // Sync Attacks (count, cost, damage, effect)
    const dbAtks = d.attacks || [];
    const oldAtks = c.attacks || [];
    const countWrong = dbAtks.length !== oldAtks.length || BROKEN_NAMES.has(c.id);
    const newAtks = [];
    for (let i = 0; i < dbAtks.length; i++) {
      const da = dbAtks[i];
      const oa = !countWrong ? oldAtks[i] : null;
      const dbCost = (da.energy_required || []).map((e) => e.toLowerCase());
      const oaCost = (oa?.cost || []).map((e) => e.toLowerCase());
      const costDiff = [...dbCost].sort().join(',') !== [...oaCost].sort().join(',');
      if (costDiff) fixedCosts++;

      const oaDmgNum = parseInt(String(oa?.damage || '0').replace(/[^0-9]/g, ''), 10) || 0;
      const dbDmgNum = Number(da.fixed_damage || 0);
      const dmgWrong = !oa || oaDmgNum !== dbDmgNum;

      const numsOf = (s) => (String(s || '').match(/(?<!\d)([1-9]\d+)(?!\d)/g) || []).map(Number).sort((a, b) => a - b).join(',');
      const numMismatch = Boolean(da.effect && oa?.effect && numsOf(da.effect) !== numsOf(oa.effect));
      const needEffFix = Boolean(da.effect) && (!oa || !isCleanZh(oa.effect) || dmgWrong || numMismatch);
      const shouldDropPhantomEff = !da.effect && Boolean(oa?.effect) && dmgWrong;

      let atkName = oa?.name || '';
      if (dmgWrong || !atkName) {
        atkName = EXACT_ATK_TITLE[da.title] || pickTop(zhAtkTitleByEn, da.title) || oa?.name || da.title;
      }

      let atkDmg = oa?.damage ?? '';
      if (dmgWrong) {
        atkDmg = formatDamageStr(da);
      }

      let atkEff = oa?.effect || '';
      if (needEffFix) {
        const translated = translateEnglishEffectFallback(da.effect);
        if (!translated) throw Error(`Missing CHT attack translation for ${c.id} (${da.title}): ${da.effect}`);
        atkEff = translated;
        if (oa?.effect && GARBLE_RE.test(oa.effect)) fixedGarble++;
        else fixedAttacks++;
      } else if (shouldDropPhantomEff) {
        atkEff = '';
        fixedAttacks++;
      } else if (dmgWrong) {
        fixedAttacks++;
      }

      newAtks.push({ name: atkName, cost: dbCost, damage: atkDmg, effect: atkEff });
    }
    c.attacks = newAtks;
  } else {
    // Trainer card
    const enEff = d.effect || d.text || '';
    if (enEff && !isCleanZh(c.effect)) {
      const translated = translateEnglishEffectFallback(enEff);
      if (!translated) throw Error(`Missing CHT trainer translation for ${c.id} (${d.name}): ${enEff}`);
      c.effect = translated;
      fixedTrainers++;
    }
  }
}

fs.writeFileSync(CARDS_PATH, JSON.stringify(cards));
console.log('Repaired public/data/cards.json successfully:', {
  total: cards.length,
  fixedNames,
  fixedCosts,
  fixedAttacks,
  fixedAbilities,
  fixedTrainers,
  fixedGarble
});
