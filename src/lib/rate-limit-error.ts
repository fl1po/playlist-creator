export class RateLimitError extends Error {
  public readonly retryAfterSeconds: number | null;

  constructor(retryAfterSeconds: number | null) {
    super("The app has exceeded its rate limits.");
    this.name = "RateLimitError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}
