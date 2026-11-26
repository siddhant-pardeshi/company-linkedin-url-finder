"""Generate the extension icon set. Deterministic, no external assets."""

from pathlib import Path

from PIL import Image, ImageDraw

SIZE = 1024
OUT = Path(__file__).resolve().parents[1] / "apps" / "extension" / "static" / "icons"


def lerp(a: int, b: int, t: float) -> int:
    return round(a + (b - a) * t)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    top = (13, 148, 136)
    bottom = (9, 94, 89)
    gradient = Image.new("RGB", (SIZE, SIZE))
    pixels = gradient.load()
    for y in range(SIZE):
        t = y / (SIZE - 1)
        color = tuple(lerp(top[i], bottom[i], t) for i in range(3))
        for x in range(SIZE):
            pixels[x, y] = color

    mask = Image.new("L", (SIZE, SIZE), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, SIZE - 1, SIZE - 1], radius=220, fill=255)

    icon = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    icon.paste(gradient, (0, 0), mask)

    draw = ImageDraw.Draw(icon)
    white = (255, 255, 255, 246)
    window = (10, 92, 88, 255)

    # Main tower
    draw.rounded_rectangle([196, 268, 520, 760], radius=34, fill=white)
    for row in range(3):
        for col in range(2):
            x = 252 + col * 138
            y = 330 + row * 118
            draw.rounded_rectangle([x, y, x + 92, y + 74], radius=14, fill=window)

    # Side tower
    draw.rounded_rectangle([560, 400, 758, 760], radius=28, fill=(255, 255, 255, 224))
    for row in range(2):
        draw.rounded_rectangle([604, 456 + row * 108, 714, 522 + row * 108], radius=12, fill=window)

    # Check badge
    draw.ellipse([620, 596, 884, 860], fill=(255, 255, 255, 255))
    draw.line([(700, 730), (760, 792), (820, 674)], fill=(9, 110, 104, 255), width=42, joint="curve")

    for size in (16, 32, 48, 128):
        resized = icon.resize((size, size), Image.LANCZOS)
        resized.save(OUT / f"icon-{size}.png", optimize=True)

    print(f"Wrote icons to {OUT}")


if __name__ == "__main__":
    main()
