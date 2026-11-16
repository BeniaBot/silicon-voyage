# Contact sheet: tiles every image matching a pattern into one picture, numbered, so a whole tour fits on one screen.
#   python tools/sheet.py shots tour*.jpg shots/sheet.jpg [cols]
import sys, glob, os
from PIL import Image, ImageDraw
d, pat, out = sys.argv[1], sys.argv[2], sys.argv[3]
cols = int(sys.argv[4]) if len(sys.argv) > 4 else 4
files = sorted(glob.glob(os.path.join(d, pat)))
tw, th = 480, 270
rows = (len(files) + cols - 1) // cols
sheet = Image.new('RGB', (cols * tw, rows * th), (10, 10, 10))
dr = ImageDraw.Draw(sheet)
for i, f in enumerate(files):
    im = Image.open(f).convert('RGB').resize((tw, th), Image.LANCZOS)
    x, y = (i % cols) * tw, (i // cols) * th
    sheet.paste(im, (x, y))
    dr.rectangle([x, y, x + 26, y + 18], fill=(0, 0, 0))
    dr.text((x + 5, y + 3), str(i), fill=(255, 255, 0))
sheet.save(out, quality=88)
print(out, len(files))
