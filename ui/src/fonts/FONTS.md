Fraunces font files for Busyholm (WP-11)
=========================================

Use: display face for the "Busyholm" wordmark and a few display headings in the app UI.
Built by: WP-11 build agent, 2026-10-12.

Source
------
Repo: https://github.com/undercasetype/Fraunces (default branch is master)
Pinned commit SHA: 7ccdec31c6028118dce3e47fe864e3744460371d
  (master tip, checked against /repos/undercasetype/Fraunces/branches/master;
  last commit dated 2025-10-21T16:08:23Z)
Font used: the variable TTF in the repo at fonts/variable/Fraunces[SOFT,WONK,opsz,wght].ttf.
  The repo holds a usable variable TTF, so the google/fonts fallback was not needed.
Licence file: OFL.txt at the repo root, same commit.

Download URLs (pinned to the commit SHA, not a branch name)
  https://raw.githubusercontent.com/undercasetype/Fraunces/7ccdec31c6028118dce3e47fe864e3744460371d/fonts/variable/Fraunces%5BSOFT,WONK,opsz,wght%5D.ttf
  https://raw.githubusercontent.com/undercasetype/Fraunces/7ccdec31c6028118dce3e47fe864e3744460371d/OFL.txt
Lookup URLs used (GitHub API, unauthenticated)
  https://api.github.com/repos/undercasetype/Fraunces
  https://api.github.com/repos/undercasetype/Fraunces/commits/HEAD
  https://api.github.com/repos/undercasetype/Fraunces/branches/master
  https://api.github.com/repos/undercasetype/Fraunces/contents/fonts/variable?ref=7ccdec31c6028118dce3e47fe864e3744460371d
  https://api.github.com/repos/undercasetype/Fraunces/git/trees/7ccdec31c6028118dce3e47fe864e3744460371d?recursive=1

Checksums (sha256, shasum -a 256)
---------------------------------
Downloaded variable TTF (Fraunces-variable.ttf, 384052 bytes):
  0776a870a0856b296e11639505ac0cf9be5e7800bb1849dfa21a1bd182455fc0
Downloaded OFL.txt (OFL.txt, 4391 bytes):
  bdf4c22802eaf804f998195871c6b8938aac2ac14b2d78a8bd66a6f1eced833b
Intermediate static instance (Fraunces-SemiBold-Soft.static.ttf, 78764 bytes, not shipped):
  7ecded5d710588529f9915e20e86f349ba079d75474a4847b30119cc0ca4f7b6
Shipped subset (Fraunces-SemiBold-Soft.subset.woff2, 11572 bytes):
  fd763bd50521b091f86b2b9c226ce2d0cb2c496682c111c0da41fcc57ffabe5c

Instancing
----------
Tool: fontTools.varLib.instancer.instantiateVariableFont
Pinned axes (all four pinned, so the output has no fvar table):
  wght=600, opsz=48, SOFT=100, WONK=0
Name table: set by hand, because updateFontNames=True fails
  (the STAT table has no opsz=48 value). Records written:
  nameID 1 "Fraunces SemiBold Soft", nameID 2 "Regular",
  nameID 3 "1.003;UCT;Fraunces-SemiBold-Soft", nameID 4 "Fraunces SemiBold Soft",
  nameID 6 "Fraunces-SemiBold-Soft", nameID 16 "Fraunces", nameID 17 "SemiBold Soft".
  Copyright and licence records (nameID 0, 13, 14) kept as in the source.
  Note: nameID 0 in the font reads "Copyright 2020 The Fraunces Project Authors"
  while OFL.txt reads "Copyright 2018". Both are upstream text and were not changed.

Subset
------
Unicode ranges: U+0020 to U+007E (Basic Latin), plus U+2019, U+00B7, U+2026.
Result: 98 characters mapped, 108 glyphs (includes .notdef and ligature glyphs).
Layout features kept: kern, liga, calt. The font has no calt feature, so the
  output has GPOS kern and GSUB liga only.
Hinting: subsetter default (kept). Flavor: woff2. All name IDs kept.

Tools
-----
Python 3.14.8 (system python3, macOS)
fonttools 4.60.1 (exact pin, available)
brotli 1.1.0 (exact pin, available)

Commands
--------
python3 -m venv /tmp/wp11-venv
/tmp/wp11-venv/bin/pip install fonttools==4.60.1 brotli==1.1.0
curl -sSL -o /tmp/wp11-font-dl/Fraunces-variable.ttf "https://raw.githubusercontent.com/undercasetype/Fraunces/7ccdec31c6028118dce3e47fe864e3744460371d/fonts/variable/Fraunces%5BSOFT,WONK,opsz,wght%5D.ttf"
curl -sSL -o /tmp/wp11-font-dl/OFL.txt "https://raw.githubusercontent.com/undercasetype/Fraunces/7ccdec31c6028118dce3e47fe864e3744460371d/OFL.txt"
shasum -a 256 /tmp/wp11-font-dl/Fraunces-variable.ttf /tmp/wp11-font-dl/OFL.txt
/tmp/wp11-venv/bin/python -I /tmp/wp11-font-tools/inspect_vf.py /tmp/wp11-font-dl/Fraunces-variable.ttf
/tmp/wp11-venv/bin/python -I /tmp/wp11-font-tools/make_subset.py /tmp/wp11-font-dl/Fraunces-variable.ttf /tmp/wp11-font-out/Fraunces-SemiBold-Soft.static.ttf /tmp/wp11-font-out/Fraunces-SemiBold-Soft.subset.woff2
/tmp/wp11-venv/bin/python -I /tmp/wp11-font-tools/verify_subset.py /tmp/wp11-font-out/Fraunces-SemiBold-Soft.subset.woff2
shasum -a 256 /tmp/wp11-font-out/Fraunces-SemiBold-Soft.subset.woff2

The scripts (inlined so this note is self-contained; they live in /tmp/wp11-font-tools/):

make_subset.py:
import sys
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer
from fontTools import subset

SRC = sys.argv[1]          # downloaded variable TTF (read only)
STATIC = sys.argv[2]       # intermediate static instance
OUT = sys.argv[3]          # final woff2 subset

# a. static instance: pin all four axes (name table is set by hand below,
#    because updateFontNames fails: STAT has no opsz=48 value)
vf = TTFont(SRC)
static = instancer.instantiateVariableFont(
    vf,
    {"wght": 600, "opsz": 48, "SOFT": 100, "WONK": 0},
    updateFontNames=False,
)

NAMES = {
    3: "1.003;UCT;Fraunces-SemiBold-Soft",
    1: "Fraunces SemiBold Soft",
    2: "Regular",
    4: "Fraunces SemiBold Soft",
    6: "Fraunces-SemiBold-Soft",
    16: "Fraunces",
    17: "SemiBold Soft",
}
for nid, val in NAMES.items():
    static["name"].setName(val, nid, 3, 1, 0x409)
    static["name"].setName(val, nid, 1, 0, 0)
static.save(STATIC)
print("static instance saved:", STATIC)

# b. subset: Basic Latin + U+2019, U+00B7, U+2026; kern/liga/calt only; woff2
unicodes = list(range(0x0020, 0x007E + 1)) + [0x2019, 0x00B7, 0x2026]
opts = subset.Options()
opts.layout_features = ["kern", "liga", "calt"]
opts.flavor = "woff2"
opts.notdef_outline = True
opts.name_IDs = ["*"]
opts.name_languages = ["*"]
opts.glyph_names = False

font = TTFont(STATIC)
sub = subset.Subsetter(options=opts)
sub.populate(unicodes=unicodes)
sub.subset(font)
font.flavor = "woff2"
font.save(OUT)
print("subset saved:", OUT)

verify_subset.py:
import sys, os
from fontTools.ttLib import TTFont
path = sys.argv[1]
f = TTFont(path)
print("file:", os.path.basename(path), "size:", os.path.getsize(path), "bytes")
print("flavor:", f.flavor)
print("family (nameID 1, win):", f["name"].getDebugName(1))
print("family (nameID 16):", f["name"].getDebugName(16))
print("full name (4):", f["name"].getDebugName(4))
print("postscript (6):", f["name"].getDebugName(6))
print("glyph count:", len(f.getGlyphOrder()))
print("has fvar (should be False):", "fvar" in f)
print("usWeightClass:", f["OS/2"].usWeightClass)
cmap = f.getBestCmap()
want = list(range(0x20, 0x7F)) + [0x2019, 0x00B7, 0x2026]
missing = [hex(c) for c in want if c not in cmap]
extra = sorted(c for c in cmap if c not in want)
print("cmap entries:", len(cmap), "missing wanted:", missing, "extra cps:", [hex(c) for c in extra][:10])
gsub = sorted({fr.FeatureTag for fr in f["GSUB"].table.FeatureList.FeatureRecord}) if "GSUB" in f else []
gpos = sorted({fr.FeatureTag for fr in f["GPOS"].table.FeatureList.FeatureRecord}) if "GPOS" in f else []
print("GSUB features:", gsub)
print("GPOS features:", gpos)

inspect_vf.py:
import sys
from fontTools.ttLib import TTFont
f = TTFont(sys.argv[1])
print("fvar axes:")
for a in f["fvar"].axes:
    print("  ", a.axisTag, a.minValue, a.defaultValue, a.maxValue)
print("instances:", len(f["fvar"].instances))
for rec in f["name"].names:
    if rec.nameID in (1, 2, 4, 6, 16, 17, 13, 14) and rec.platformID == 3:
        print("name", rec.nameID, rec.toUnicode())
print("has STAT:", "STAT" in f, "glyphs:", len(f.getGlyphOrder()))
print("GSUB features:", sorted({fr.FeatureTag for fr in f["GSUB"].table.FeatureList.FeatureRecord}) if "GSUB" in f else None)
print("GPOS features:", sorted({fr.FeatureTag for fr in f["GPOS"].table.FeatureList.FeatureRecord}) if "GPOS" in f else None)

Verification (run 2026-10-12)
-----------------------------
Opens with fontTools TTFont: yes. Flavor: woff2. No fvar table: yes. usWeightClass: 600.
Family name (nameID 1): Fraunces SemiBold Soft. Typographic family (nameID 16): Fraunces.
Glyph count: 108. Wanted codepoints missing: none. Extra codepoints: none.

Licence
-------
Fraunces is licensed under the SIL Open Font License 1.1; see OFL.txt. The Reserved Font Name rules of the OFL apply to modified versions; this subset keeps the original name only as allowed by the licence

Reserved Font Name decision: the OFL.txt header reads "Copyright 2018 The Fraunces Project Authors (https://github.com/undercasetype/Fraunces)" and nothing follows it. No "with Reserved Font Name" clause is declared, so no name is reserved. The subset keeps "Fraunces" in nameID 16 and uses "Fraunces SemiBold Soft" as the full and family display name (nameID 1, 4).
