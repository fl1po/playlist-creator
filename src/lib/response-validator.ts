import type { IValidateResponses } from '@spotify/web-api-ts-sdk';
import { RateLimitError } from './rate-limit-error.js';
import { HttpError } from './resilience/errors.js';

export class RetryAfterResponseValidator implements IValidateResponses {
  public async validateResponse(response: Response): Promise<void> {
    switch (response.status) {
      case 401:
        throw new HttpError(
          401,
          'Bad or expired token. This can happen if the user revoked a token or the access token has expired. You should re-authenticate the user.',
        );
      case 403: {
        const body = await response.text();
        throw new HttpError(
          403,
          `Bad OAuth request (wrong consumer key, bad nonce, expired timestamp...). Unfortunately, re-authenticating the user won't help here. Body: ${body}`,
        );
      }
      case 429: {
        const retryAfterHeader = response.headers.get('retry-after');
        const retryAfterSeconds =
          retryAfterHeader !== null ? Number(retryAfterHeader) : null;
        throw new RateLimitError(
          Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : null,
        );
      }
      default:
        if (!response.status.toString().startsWith('20')) {
          const body = await response.text();
          throw new HttpError(
            response.status,
            `Unrecognised response code: ${response.status} - ${response.statusText}. Body: ${body}`,
          );
        }
    }
  }
}
