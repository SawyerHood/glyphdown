/**
 * Error carrying a process exit code. Exit codes follow SPEC §8.3:
 *   1 = generic failure (auth, network, bad arguments, server error)
 *   2 = push partially applied — failed hunks were printed (like git .rej)
 *   3 = degenerate push refused (doc drifted and the change rewrites most of it)
 */
export class CliError extends Error {
  /** HTTP status that produced this error, when it came from the API. */
  readonly status: number | undefined

  constructor(
    readonly exitCode: number,
    message: string,
    opts: { status?: number } = {},
  ) {
    super(message)
    this.name = 'CliError'
    this.status = opts.status
  }
}

/** SPEC §8.3 step 5 — the exact degenerate-rejection message. */
export const DEGENERATE_MESSAGE =
  'doc has concurrent edits and your change rewrites most of it — re-pull or --force'
