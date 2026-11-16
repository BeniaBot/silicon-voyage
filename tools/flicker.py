# Shimmer map: for each pair of frames one 60 Hz step apart (fl0a/fl0b ...), the difference amplified 6 times.
# Real motion gives soft, smooth differences; aliasing and popping give bright isolated specks. Prints the mean and
# the 99.9th percentile of the difference per pair, and saves all maps side by side.
#   python tools/flicker.py shots/flicker
import sys, glob, os
from PIL import Image, ImageChops
d = sys.argv[1]
pairs = sorted(glob.glob(os.path.join(d, 'fl*a.png')))
tiles = []
for a in pairs:
    A = Image.open(a).convert('L'); B = Image.open(a[:-5] + 'b.png').convert('L')
    D = ImageChops.difference(A, B)
    h = D.histogram(); n = sum(h); mean = sum(i * c for i, c in enumerate(h)) / n
    acc = 0; p999 = 0
    for i in range(255, -1, -1):
        acc += h[i]
        if acc >= n * .001: p999 = i; break
    print(os.path.basename(a)[:-5], 'mean %.2f' % mean, 'p99.9', p999)
    tiles.append(D.point(lambda v: min(255, v * 6)).resize((640, 360), Image.BILINEAR))
sheet = Image.new('L', (640 * 3, 360 * ((len(tiles) + 2) // 3)))
for i, t in enumerate(tiles): sheet.paste(t, ((i % 3) * 640, (i // 3) * 360))
sheet.save(os.path.join(d, 'flicker.jpg'), quality=88)
