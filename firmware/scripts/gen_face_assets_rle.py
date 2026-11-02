#!/usr/bin/env python3
"""把表情/特效 PNG 重新生成 main/display/face_assets.c（RLE 压缩）。

用法：
  python3 gen_face_assets_rle.py <png目录> <工程 main/display 目录> [LVGLImage.py 路径]

<png目录> 里需要这些文件（2.5.0 归档 assets/2.5.0/）：
  neutral.png neutral_blink.png attack_flat.png attack.png hurt.png guard.png
  dodge.png face_ultready.png victory.png defeat.png
  face_surprised.png face_kiss.png face_thinking.png face_sleep.png
  fx_bang.png fx_heart.png fx_question.png fx_z1.png fx_z2.png fx_z3.png

说明：
- 战斗表情/特效是透明前景，用 RGB565A8 + RLE；
- 4 个日常表情把底色 #1A4038 烘进图里，用 RGB565 + RLE（省掉透明平面）；
- 6 个图标在 battle_assets.c 里，不要在这里重复生成，否则链接会 multiple definition；
- LVGL 侧必须开 CONFIG_LV_USE_RLE=y，否则解码直接失败（表情不显示）。
"""
import os
import shutil
import subprocess
import sys

from PIL import Image

BG = (0x1A, 0x40, 0x38)

# 顺序与 face_assets.c 里的资源顺序保持一致
ASSETS = [
    ("face_neutral", "neutral.png", "RGB565A8", False),
    ("face_neutral_blink", "neutral_blink.png", "RGB565A8", False),
    ("face_attack_flat", "attack_flat.png", "RGB565A8", False),
    ("face_attack", "attack.png", "RGB565A8", False),
    ("face_hurt", "hurt.png", "RGB565A8", False),
    ("face_guard", "guard.png", "RGB565A8", False),
    ("face_dodge", "dodge.png", "RGB565A8", False),
    ("face_ultready", "face_ultready.png", "RGB565A8", False),
    ("face_victory", "victory.png", "RGB565A8", False),
    ("face_defeat", "defeat.png", "RGB565A8", False),
    ("face_charge", "charge.png", "RGB565A8", False),
    ("face_heavy", "heavy.png", "RGB565A8", False),
    ("face_heavy_sw0", "heavy_sw0.png", "RGB565A8", False),
    ("face_heavy_sw1", "heavy_sw1.png", "RGB565A8", False),
    ("face_heavy_sw2", "heavy_sw2.png", "RGB565A8", False),
    ("face_heavy_sw3", "heavy_sw3.png", "RGB565A8", False),
    ("face_heavy_sw4", "heavy_sw4.png", "RGB565A8", False),
    ("face_heavy_sw5", "heavy_sw5.png", "RGB565A8", False),
    ("face_heavy_sw6", "heavy_sw6.png", "RGB565A8", False),
    ("face_surprised", "face_surprised.png", "RGB565", True),
    ("face_kiss", "face_kiss.png", "RGB565", True),
    ("face_thinking", "face_thinking.png", "RGB565", True),
    ("face_sleep", "face_sleep.png", "RGB565", True),
    ("fx_bang", "fx_bang.png", "RGB565A8", False),
    ("fx_heart", "fx_heart.png", "RGB565A8", False),
    ("fx_question", "fx_question.png", "RGB565A8", False),
    ("fx_z1", "fx_z1.png", "RGB565A8", False),
    ("fx_z2", "fx_z2.png", "RGB565A8", False),
    ("fx_z3", "fx_z3.png", "RGB565A8", False),
]


def main() -> int:
    if len(sys.argv) < 3:
        print(__doc__)
        return 2
    png_dir = os.path.abspath(sys.argv[1])
    out_dir = os.path.abspath(sys.argv[2])
    conv = sys.argv[3] if len(sys.argv) > 3 else os.path.join(
        os.path.dirname(out_dir), "..", "scripts", "Image_Converter", "LVGLImage.py")

    work = "/tmp/face_assets_rle"
    shutil.rmtree(work, ignore_errors=True)
    os.makedirs(os.path.join(work, "src"))
    os.makedirs(os.path.join(work, "c"))

    total = 0
    for sym, name, cf, flatten in ASSETS:
        im = Image.open(os.path.join(png_dir, name)).convert("RGBA")
        if flatten:
            base = Image.new("RGBA", im.size, BG + (255,))
            base.alpha_composite(im)
            im = base.convert("RGB")
        dst = os.path.join(work, "src", sym + ".png")
        im.save(dst)
        subprocess.run([sys.executable, conv, "--ofmt", "C", "--cf", cf,
                        "--compress", "RLE", "-o", os.path.join(work, "c"), dst],
                       check=True, capture_output=True)
        size = os.path.getsize(os.path.join(work, "c", sym + ".c"))
        total += size
        print(f"{sym:22s} {cf:9s} {im.size[0]}x{im.size[1]:<4d} c={size:7d}")

    parts = ["/* 自动生成：SVG 画板渲染的表情前景与特效前景（RGB565/RGB565A8，RLE 压缩），勿手改 */\n",
             "#include <lvgl.h>\n", '#include "face_assets.h"\n\n']
    for sym, _, _, _ in ASSETS:
        gen = open(os.path.join(work, "c", sym + ".c"), encoding="utf-8").read()
        start = gen.index("#ifndef LV_ATTRIBUTE_MEM_ALIGN")
        parts.append(gen[start:].rstrip() + "\n\n")

    target = os.path.join(out_dir, "face_assets.c")
    with open(target, "w", encoding="utf-8") as f:
        f.write("".join(parts))
    print(f"wrote {target} ({os.path.getsize(target)} bytes), C source total {total}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
