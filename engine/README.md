# 本地自对弈规则引擎

本目录保存训练和评估实际使用的 Rust 规则源码。上游为 [DeckGym 固定提交 a0f9d14](https://github.com/bcollazo/deckgym-core/tree/a0f9d14bf2dd2a342e53cd7057486d7ce96ea545)，采用 AGPL-3.0。源码归档包含原始 Cargo 清单、锁文件、Rust 源码、牌库和示例牌表，SHA-256 为 `1de0d38c441e4360b7b9f215057fa1eb70a3facd22de50bef0011cbca4391ed6`。新增的对战接口与命令行入口保存在同目录的 `pocket_lab.rs` 和 `pocket_lab_cli.rs` 中，沿用相同许可。

## 运行

在项目根目录运行以下命令。Windows 默认生成 WASI 程序并由本机 Node 执行，使用 Rust 的 `wasm32-wasip1` 标准库。其他平台默认构建原生程序。可以使用 `--wasi` 或 `--native` 显式选择构建目标。

```text
node tools/battle/build.mjs
node tools/battle/run-engine-smoke.mjs
node tools/battle/run-engine.mjs
```

最后一条命令持续接收标准输入。每行输入和输出都是单独一个 JSON 对象。训练进程可以多次提交同一进程。覆盖检查使用 `{"op":"coverage","ids":["C1-018"]}`；字段 `coverage` 将卡号映射到上游规则状态。牌组字段 `cards` 是含 `id` 和 `count` 的数组，`energy` 使用一至三种可生成的能量。每场 `op: "game"` 需要牌组 `deck`、`enemy`、22 个有限数值的 `weights`、32 位非负整数 `seed` 和先手座位 `first`（自己为 0，对手为 1）。可传不同的 `enemy_weights`；省略时双方使用相同权重。批量输入使用 `{"op":"batch","games":[…]}`，输出的 `results` 与请求顺序相同，遇到规则或牌组错误的对局返回 `error`。

结果记录胜负平、回合数、动作数、双方得分及先手座位。传入 `replay: true` 会附带各动作执行时的回合、决策者、动作及执行后得分。按牌面能量费用、随机抽牌与官方规则效果产生的随机结果使用引擎的固定种子。模拟采用上游对战规则和每回合 100 个动作的防循环限制。单局超过 3000 步视为执行错误。

## 决策输入

规则引擎生成每步合法行动。策略为每种行动计算 22 项特征并与权重作内积，选择得分最高的合法行动。特征使用当前可见的场地、伤害、附着能量、自己的手牌数量及合法行动描述。玩家自行选择了某个对手牌组进行评测时，策略仍无法读取对方手牌或任何一方的抽牌顺序。相同分数使用行动文本进行稳定决胜。具体特征顺序对应 `pocket_lab.rs` 的 `score`。
