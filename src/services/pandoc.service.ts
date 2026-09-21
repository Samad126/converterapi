/**
 * The markup/plain-text document sources - `.md`, `.rst`, `.tex`, `.textile`,
 * `.org`, `.opml`, `.muse`, `.ipynb` - reaching `docx`/`html`/`odt`/`rtf`/
 * `txt`/`markdown`, with no LibreOffice involved.
 *
 * None of these is a document soffice opens, so - exactly as PDF's `docx`/
 * `pptx`/`xlsx`/`markdown` route through `pdf_engine.py` instead of a
 * `--convert-to` - these route through `pandoc`. `formats.ts` names the
 * mechanism explicitly via `TargetFormat.engineFrom.pandoc`.
 *
 * AsciiDoc (`.adoc`) is deliberately not a source here: Debian's `pandoc`
 * package ships without the `asciidoc` reader (`pandoc --list-input-formats`
 * does not list it, and `pandoc -f asciidoc` fails with "Unknown input
 * format asciidoc" on the exact build this service was verified against) -
 * adding it to the matrix would advertise a conversion that 500s on every
 * request, which is worse than not offering it.
 *
 * Reuses `runProcess` from soffice.service.ts rather than a second copy of
 * it, for the same reason `pdf-engine.service.ts` does: the failure modes -
 * a wedged process, a client that left, a deadline shared with the rest of
 * the pipeline - are identical, and two engines disagreeing about how a
 * subprocess is killed would be a bug waiting to happen.
 */
import { PANDOC_BIN } from '../config.ts';
import { runProcess, type ProcessOutcome } from './soffice.service.ts';

/**
 * The pandoc writer name for each target this engine reaches.
 *
 * `markdown` needs its own writer name (`gfm`, not `markdown`): pandoc's
 * plain `markdown` writer round-trips its own extension syntax (pipe tables
 * with `:---:` alignment markers, footnote syntax, etc.) that most
 * consumers of a "give me a .md file" endpoint do not expect and do not
 * render. GitHub-Flavored Markdown is the shape people mean when they ask
 * for Markdown, and it is what the PDF-sourced `markdown` target's own
 * heuristics (`pdf_engine.py`) already produce prose- and table-wise, so
 * the two routes to the same target id stay close in spirit.
 */
export const PANDOC_WRITERS: Record<string, string> = {
  docx: 'docx',
  html: 'html',
  odt: 'odt',
  rtf: 'rtf',
  txt: 'plain',
  markdown: 'gfm',
};

export interface PandocRun {
  inputPath: string;
  outputPath: string;
  /** One of `PANDOC_WRITERS`'s values. */
  writer: string;
  workspace: string;
  deadline: number;
  signal?: AbortSignal;
}

export function runPandoc(run: PandocRun): Promise<ProcessOutcome> {
  const { inputPath, outputPath, writer, workspace, deadline, signal } = run;

  return runProcess({
    bin: PANDOC_BIN,
    // Pandoc infers the READER from the input file's extension the same way
    // soffice does, so no `-f` is passed - `formats.ts`'s `engineFrom.pandoc`
    // list is exactly the set of extensions pandoc's own auto-detection
    // recognises, verified per entry (see its own comment on `.adoc`).
    args: ['--standalone', '-t', writer, '-o', outputPath, inputPath],
    workspace,
    deadline,
    signal,
    // Pandoc does not touch $HOME the way soffice's profile or Python's
    // `pip install --user` packages do, but the same "point HOME/TMPDIR at
    // the workspace" default `runProcess` already applies is harmless here
    // and keeps this call ordinary rather than a special case.
  });
}
