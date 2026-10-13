/**
 * The server-wide Anthropic key, set by the operator like `LASTFM_API_KEY`.
 * AI finds run only when it's present and the user has opted in.
 */
export function anthropicKeyFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return env.ANTHROPIC_API_KEY || undefined;
}

/** Whether this server can run AI finds at all. */
export function aiFindsAvailable(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return anthropicKeyFromEnv(env) !== undefined;
}
