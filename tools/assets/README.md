# 素材同步工具（能量图标 + 宝可梦 2D 像素画）

用于把繁中卡牌图鉴、卡组代表宝可梦与属性选择器用到的本地化图标落盘到 `public/assets/` 与 `public/data/sprites.json`，避免运行时高频跨域外链：

- `public/assets/energy/{grass,fire,water,lightning,psychic,fighting,darkness,metal,colorless,dragon,fairy}.png`：来自 52Poké `*_TCG.png` 原版球状能量标识。
- `public/assets/energy/trainer.png`：来自 Pokésprite 原版 2D 像素精灵球图标。
- `public/assets/pokemon/{slug}.png`：全量收录 `public/data/cards.json` 中全部宝可梦种类及形态（基础、阿罗拉/伽勒尔/洗翠/帕底亚地区形态、Mega 进化及各特殊形态）的原版 2D 点阵图；优先采用 Pokésprite Gen 8 经典全身 2D 像素图，第九世代与 Z-A 新超级进化自动回退至 Limitless TCG Pocket R2 像素图库，并使用 Pillow 裁掉多余透明边距以保证在牌组标题旁紧凑对齐。

## 执行方式

```powershell
python tools/assets/sync_sprites.py
```

每当 `tools/cards/` 采集新卡包（如 `C2` 等）更新 `public/data/cards.json` 后，重新执行一次即可增量补齐新宝可梦像素画。
