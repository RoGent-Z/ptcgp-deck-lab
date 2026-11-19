# Pocket Lab · Pokémon TCG Pocket 繁中组牌与对战模拟站

> 仓库目标：`https://github.com/RoGent-Z/ptcgp-deck-lab`（GitHub Pages 静态托管，无构建步骤）。

## 用途

面向 Pokémon TCG Pocket 玩家的繁中查卡、本地组牌与环境对抗实验工具：

1. **繁中卡牌图鉴与组牌**：保留 52Poké 繁中卡名、招式与效果，支持简体中文（OpenCC 折叠）实时搜索，校验 20 张 / 同名跨异画上限 2 张 / 基础宝可梦 / 能量区（1–3 种）合法性。
2. **本地牌组存储**：基于浏览器 IndexedDB（`ptcgp-deck-lab-v1`）保存草稿、多套牌组、收藏持卡量与对战批次元数据，支持标准 JSON 导入与导出。
3. **实时赛事环境排行**：采集 Limitless 公开 Standard 单牌组赛事，支持按使用率、赛事胜率、冠军次数、八强次数切换排行，展示代表 20 张牌表及赛事出处并可一键克隆。
4. **10 × 50 局对战模拟**：以 `deckgym-core`（AGPL-3.0）编译为浏览器 WASM 规则引擎，对当前使用率前十牌组各进行先手 25 局、后手 25 局（共 500 局）模拟，统计综合胜率、Wilson 95% 区间，并支持断点续跑与种子逐局回放。

## 目录结构

```text
Project_15_宝可梦卡牌对战模拟站/
├─ docs/                    # 计划书、修订规划、前端艺术设计规范、接手指南与接手日志
├─ public/                  # GitHub Pages 静态站根目录
│  ├─ index.html            # 页面入口（桌面顶栏 + 移动端底部导航）
│  ├─ app/                  # 原生 ES Module 前端（夜间牌桌设计系统、CardFace、对战点阵、IndexedDB）
│  ├─ assets/               # 封面图 tabletop.webp、商标 mark.svg、Barlow 字体、OpenCC 简繁字典
│  ├─ data/                 # 赛事快照 meta.json / meta.top.json 与繁中全卡库 cards.json / catalog.json
│  └─ battle/               # 规则引擎 WASM 与 AI 权重（M3/M5 构建产物目录）
├─ engine/                  # Rust/WASM 桥接源码 pocket_lab.rs 与 AGPL-3.0 源码归档
├─ tools/                   # 赛事同步 tools/meta/、繁中卡库采集 tools/cards/、简繁字典工具
├─ .github/workflows/       # 自动化测试门禁 (test.yml) 与定时同步/Pages 部署 (deploy.yml)
├─ tests/                   # Node 原生单元测试
└─ data/                    # 采集缓存（已在 .gitignore 排除，不入 Git 历史）
```

## 常用入口

- **线上体验**：`https://rogent-z.github.io/ptcgp-deck-lab/`
- **Android APK**：可至 GitHub Releases 下载 `PocketLab-v0.0.1-android.apk` 安装使用（基于 Capacitor 打包 `public/`，图标使用 `public/assets/mark.svg` 同款瑞士红白方块精灵球）。
- **接手与架构文档**：[docs/00_接手指南.md](docs/00_接手指南.md)
- **前端设计规范**：[docs/03_前端艺术设计规范.md](docs/03_前端艺术设计规范.md)
- **本地预览**：运行 `node tmp/serve.mjs` 后浏览器打开 `http://127.0.0.1:4157/`（完整 4,577 张繁中卡牌与 61 场赛事环境已可正常交互；若要预览 M3 完成前的 500 格演示点阵可访问 `?fixture=1#battle`）。
- **测试命令**：`npm test`（或 `node --test tests/*.test.mjs`）

## 当前状态

- **已完成（M0 + M1 + M2 + M4 + 赛事管线）**：
  - `tools/meta/*` 已抓取 C1「Dual Fusion」赛季真实快照（61 场赛事 / 7,099 人次 / 19,412 场对局 / 537 原型，含 `meta.top.json`）；
  - `tools/cards/*` 已生成完整 **4,577 张**繁中卡牌 `cards.json` 与 27 系列 `catalog.json`（52Poké 精准匹配 4,562 张 + 15 张官译兜底）；
  - 前端 6 大页面、数据卡面组件与 50 格点阵界面已完成真卡库实机验收，14 项单元测试全部通过；
  - `.github/workflows/test.yml` 与 `deploy.yml` 已按分层定时和 Pages Artifact 发布就位。
- **待续作（M3 / M5 / M6）**：Rust 规则引擎 WASM 编译（需 `cargo` + `wasm32-unknown-unknown`）、AI 模型权重训练与正式 GitHub Pages 上线验收（详见 `docs/00_接手指南.md`）。

## 后续维护

- 修改视觉令牌或布局组件时，先同步更新 `docs/03_前端艺术设计规范.md` 再改 `public/app/site.css`。
- 禁止将 `data/meta/cache-v1/` 原始赛事缓存提交进 Git 仓库。
