/**
 * `assimp` (Open Asset Import Library), run as a subprocess exactly as
 * `ffmpeg`/`heif-convert` are - the 3D-model engine: `.obj`/`.stl`/`.ply`/
 * `.glb`/`.3mf`/`.off` in, any of `obj`/`stl`/`ply`/`glb`/`3mf` out. A flat
 * format-to-format tool like `ffmpeg`, so this is one function, not a
 * pipeline - `assimp export <in> <out>` picks both the reader and the writer
 * from each path's own extension, verified by hand for every pair this
 * service actually advertises (`obj`<->`stl`<->`ply`<->`glb`<->`3mf`, plus
 * `.off` reading into every one of the five).
 *
 * `.off` IS NOT A WRITE TARGET - deliberately, and not merely an omission.
 * `assimp listexport` does not list it at all (verified by hand), and asking
 * for it anyway fails with "no output format specified and I failed to
 * guess it" - the same "read-only in this real build" shape `.rar` already
 * has elsewhere in this service, for the same reason: a filter this codebase
 * does not trust until it has actually been run.
 *
 * A `.obj` TARGET writes a companion `.mtl` file alongside it (verified by
 * hand - even from a source with no materials at all), which this function
 * does nothing special for: `collectProducedFiles(outDir, target.extension)`
 * in `conversion.pipeline.ts` already filters by extension, so the `.mtl`
 * simply never matches and is left behind unread, the same as it would be
 * for any other engine's incidental output file.
 */
import { ASSIMP_BIN } from '../config.ts';
import { runProcess, type ProcessOutcome } from './soffice.engine.ts';

export interface AssimpRun {
  inputPath: string;
  outputPath: string;
  workspace: string;
  deadline: number;
  signal?: AbortSignal;
}

export function runAssimpExport(run: AssimpRun): Promise<ProcessOutcome> {
  const { inputPath, outputPath, workspace, deadline, signal } = run;

  return runProcess({
    bin: ASSIMP_BIN,
    args: ['export', inputPath, outputPath],
    workspace,
    deadline,
    signal,
  });
}
