#!/usr/bin/env python3
"""
The columnar-data engine: `.parquet`/`.orc`/`.feather` in, any of the same
three out - and the bridge that lets them join `data.service.ts`'s own
CSV/TSV/JSON/JSONL/YAML/XML/TOML/INI/SQLite group, the same "one common JS
value" model every member of it already shares.

Unlike every other member of that group, none of this is pure JS - `pyarrow`
is the real, standard tool for all three formats (verified by hand: `pip
install pyarrow` on the exact `node:22-bookworm-slim` image this service's
own Dockerfile builds from, then a full read/write round trip through all
three), and there is no comparable JS library worth trusting the way
`xml-js`/`smol-toml`/`ini` were for the pure-JS members. So this script is
the SAME shape `pdf_engine.py` already is for `docx`/`pptx`/`xlsx` - a
second, non-Node engine `conversion.service.ts` shells out to - except here
the bridge is JSON, not a document format: `arrow.service.ts` calls this
script to translate bytes on one side into the exact JSON text
`parseDataSource`/`serializeDataTarget` already know how to consume/produce
on the other, so `data.service.ts` itself never needs to know a subprocess
was involved.

Invocation, matching what arrow.service.ts spawns:

    arrow_engine.py read  <input.parquet|.orc|.feather> <output.json>
    arrow_engine.py write <input.json> <output.parquet|.orc|.feather>

`read` writes a JSON array of flat row objects - the exact same shape
`data.service.ts`'s own CSV/TSV reader already produces, verified by hand
(a table's rows round-trip through `pyarrow.Table.to_pylist()` and
`json.dump` losslessly for every JSON-representable type Arrow's own scalar
types cover: strings, numbers, booleans, null). `write` requires the SAME
shape back - a top-level JSON array of flat objects - the identical
"a top-level array of flat objects" requirement CSV/TSV/SQLite already
enforce elsewhere in this engine, checked here before `pyarrow` gets a
chance to raise something less clear.

Exit codes:
    0  wrote the output
    1  failed - stderr has a human-unreadable but log-worthy reason
"""
import json
import sys


def _format_for(path: str) -> str:
    ext = '.' + path.rsplit('.', 1)[-1].lower() if '.' in path else ''
    if ext not in ('.parquet', '.orc', '.feather'):
        raise ValueError(f'unsupported arrow extension "{ext}"')
    return ext


def run_read(input_path: str, output_path: str) -> int:
    import pyarrow.feather as feather
    import pyarrow.orc as orc
    import pyarrow.parquet as pq

    fmt = _format_for(input_path)
    if fmt == '.parquet':
        table = pq.read_table(input_path)
    elif fmt == '.orc':
        table = orc.read_table(input_path)
    else:
        table = feather.read_table(input_path)

    with open(output_path, 'w', encoding='utf-8') as fh:
        json.dump(table.to_pylist(), fh)
    return 0


def run_write(input_path: str, output_path: str) -> int:
    import pyarrow as pa
    import pyarrow.feather as feather
    import pyarrow.orc as orc
    import pyarrow.parquet as pq

    with open(input_path, encoding='utf-8') as fh:
        rows = json.load(fh)

    if not isinstance(rows, list) or not all(isinstance(row, dict) for row in rows):
        print('input must be a top-level JSON array of flat objects', file=sys.stderr)
        return 1

    table = pa.Table.from_pylist(rows)
    fmt = _format_for(output_path)
    if fmt == '.parquet':
        pq.write_table(table, output_path)
    elif fmt == '.orc':
        orc.write_table(table, output_path)
    else:
        feather.write_feather(table, output_path)
    return 0


def main() -> int:
    if len(sys.argv) != 4 or sys.argv[1] not in ('read', 'write'):
        print('usage: arrow_engine.py <read|write> <input-path> <output-path>', file=sys.stderr)
        return 1

    operation, input_path, output_path = sys.argv[1], sys.argv[2], sys.argv[3]
    return run_read(input_path, output_path) if operation == 'read' else run_write(input_path, output_path)


if __name__ == '__main__':
    sys.exit(main())
