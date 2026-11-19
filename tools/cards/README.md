# 繁中卡库采集与构筑工具 (`tools/cards`)

## 数据源与许可

1. **全印刷版本骨架**：`flibustier/pokemon-tcg-pocket-database`（MIT License），提供全 27 个系列共 4,577 张印刷版本的卡号、稀有度、卡包、基础属性、进化阶段与英文原名。
2. **繁体中文卡名与效果**：**52Poké 神奇宝贝百科**（CC BY-NC-SA 3.0）：
   - 优先使用 `52poke/mwarchiver` 官方公开 XML 离线归档提取词条原文及 `revision` 修订号；
   - 通过 52Poké MediaWiki API 仅对当季与近期更新系列列表页（如 `雙元融合（TCGP）`、`高级补充包MEGA（TCGP）`、`B/C系列特典卡（TCGP）`）执行轻量增量拉取，串行间隔 ≥ 650 ms 并携带清晰 `User-Agent`；
   - 极少数 52Poké 尚未建页的新卡（如部分 `P-B`/`P-C` 特典卡）采用官译对照表兜底，并在 `source` 中如实标明。

## 运行方式

```bash
# 全流程同步（下载缺失原始档案 + 轻量刷新活跃系列列表 + 生成 cards.json 与 catalog.json）
node tools/cards/sync.mjs

# 仅使用本地已缓存数据离线重建
node tools/cards/sync.mjs --skip-download --skip-live-sets
```

输出产物：`public/data/cards.json` 与 `public/data/catalog.json`。
