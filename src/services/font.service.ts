/**
 * `scripts/font_engine.py` (`fontTools`), run as a subprocess exactly as
 * `pdf_engine.py` is - the font engine: `.ttf`/`.otf`/`.woff`/`.woff2` in,
 * any of the same four out. A flat format-to-format tool like `ffmpeg`/
 * `assimp`/`ebook-convert`, so this is one function, not a pipeline - see
 * `font_engine.py`'s own header comment for what it actually does to each
 * pair (a container swap for `.ttf`<->`.otf`, a real WOFF/WOFF2 (de)compress
 * for the other two).
 */
import { FONT_ENGINE_SCRIPT, PYTHON_BIN } from '../config.ts';
import { runProcess, type ProcessOutcome } from './soffice.service.ts';

export interface FontRun {
  inputPath: string;
  outputPath: string;
  workspace: string;
  deadline: number;
  signal?: AbortSignal;
}

export function runFontConvert(run: FontRun): Promise<ProcessOutcome> {
  const { inputPath, outputPath, workspace, deadline, signal } = run;

  return runProcess({
    bin: PYTHON_BIN,
    args: [FONT_ENGINE_SCRIPT, inputPath, outputPath],
    workspace,
    deadline,
    signal,
  });
}
