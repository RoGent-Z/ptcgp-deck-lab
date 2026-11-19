"""Render validation scores from a completed Pocket Lab training run."""

from argparse import ArgumentParser
import json
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
from matplotlib import pyplot as plt, ticker
from matplotlib.font_manager import FontProperties


def main():
    parser = ArgumentParser(description=__doc__)
    parser.add_argument("run_dir", type=Path)
    args = parser.parse_args()
    training = json.loads((args.run_dir / "training.json").read_text(encoding="utf-8"))
    generations = training["generations"]
    if len(generations) != training["config"]["generations"]:
        raise ValueError("The training checkpoint is incomplete")

    font_path = Path("C:/Windows/Fonts/msyh.ttc")
    chinese = font_path.is_file()
    font = FontProperties(fname=font_path) if chinese else FontProperties()
    title = "C1 对战策略训练" if chinese else "C1 battle policy training"
    x_label = "训练轮次" if chinese else "Training round"
    y_label = "对冻结基线的得分率" if chinese else "Score against frozen baseline"
    candidate_label = "本轮最佳候选" if chinese else "Best candidate this round"
    champion_label = "截至该轮的保留模型" if chinese else "Best retained policy"
    footer = ("验证牌表为赛事第 27–30 名，每个候选 192 局，和局计半分。"
              if chinese else "Validation ranks 27–30. 192 games per candidate. Draws are worth half a point.")
    rounds = [row["round"] for row in generations]
    candidate = [row["validation"]["score"] for row in generations]
    champion = [row["championValidation"]["score"] for row in generations]

    fig, ax = plt.subplots(figsize=(8.5, 4.5), layout="constrained")
    ax.plot(rounds, candidate, "o--", color="#8a6242", label=candidate_label, linewidth=1.5)
    ax.step(rounds, champion, where="post", color="#236b61", label=champion_label, linewidth=2.4)
    ax.axhline(.5, color="#83918a", linewidth=1, linestyle=":")
    ax.set(xticks=rounds, ylim=(min(.47, min(candidate) - .025), max(.54, max(champion) + .035)))
    ax.set_title(title, fontproperties=font, fontsize=17, loc="left", pad=12)
    ax.set_xlabel(x_label, fontproperties=font, fontsize=11)
    ax.set_ylabel(y_label, fontproperties=font, fontsize=11)
    ax.yaxis.set_major_formatter(ticker.PercentFormatter(1.0))
    ax.grid(axis="y", alpha=.19)
    ax.spines[["top", "right"]].set_visible(False)
    ax.legend(prop=font, loc="lower right", frameon=False)
    fig.supxlabel(footer, fontproperties=font, fontsize=10, color="#4c5753")
    fig.savefig(args.run_dir / "training-curve.png", dpi=180, facecolor="white")


if __name__ == "__main__":
    main()

