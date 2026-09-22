#!/usr/bin/env python3
"""
The font engine: `.ttf`/`.otf`/`.woff`/`.woff2` in, any of the same four out.

A flat format-to-format tool like `ffmpeg`/`assimp`/`ebook-convert` - no
per-pair flag needed. `fontTools.ttLib.TTFont` already reads all four
container formats and writes any of them back out by setting `.flavor`
before `.save()` (`None` for `.ttf`/`.otf`, `'woff'`/`'woff2'` for the other
two) - verified by hand, round-tripped through all four against a real font
(`assets/fonts/DancingScript.ttf`, already a dependency of this repo's PDF
signature feature).

`.ttf` -> `.otf` (and back) is a CONTAINER swap, not a real TrueType-to-CFF
outline conversion - `fontTools` does not do that implicitly, and this
script does not pretend to. The glyph outlines stay exactly what they were;
only the `sfnt` wrapper's declared flavor changes. This is still a real,
useful conversion (a renderer that insists on the `.otf` extension opens the
result correctly - verified by hand), just not a claim about what is inside.

Invocation, matching what font.service.ts spawns:

    font_engine.py <input-path> <output-path>

The target format is read from `<output-path>`'s own extension, the same
zero-flag convention `assimp export`/`ebook-convert` already use.

Exit codes:
    0  wrote the output
    1  failed - stderr has a human-unreadable but log-worthy reason
"""
import sys

FLAVORS = {
    '.ttf': None,
    '.otf': None,
    '.woff': 'woff',
    '.woff2': 'woff2',
}


def main() -> int:
    if len(sys.argv) != 3:
        print('usage: font_engine.py <input-path> <output-path>', file=sys.stderr)
        return 1

    input_path, output_path = sys.argv[1], sys.argv[2]
    output_ext = '.' + output_path.rsplit('.', 1)[-1].lower() if '.' in output_path else ''
    if output_ext not in FLAVORS:
        print(f'unsupported output extension "{output_ext}"', file=sys.stderr)
        return 1

    from fontTools.ttLib import TTFont

    font = TTFont(input_path)
    font.flavor = FLAVORS[output_ext]
    font.save(output_path)
    return 0


if __name__ == '__main__':
    sys.exit(main())
