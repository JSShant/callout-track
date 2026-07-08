export class AuthExpiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthExpiredError';
  }
}

export class TransientAPIError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransientAPIError';
  }
}
