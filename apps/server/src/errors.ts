/** Error with an HTTP status and machine-readable code, rendered as `{ code, message }`. */
export class AppError extends Error {
  /** `options.cause`: the underlying failure, logged server-side and never sent to the client. */
  constructor(public status: number, public code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AppError';
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Not found', options?: { cause?: unknown }) {
    super(404, 'not_found', message, options);
    this.name = 'NotFoundError';
  }
}

/** Upstream market-data failure. `retryable` = transient (rate limit, network, 5xx). */
export class ProviderError extends Error {
  constructor(public provider: string, message: string, public retryable: boolean, public status?: number) {
    super(message);
    this.name = 'ProviderError';
  }
}
