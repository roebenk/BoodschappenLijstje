export class ServiceError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ServiceError";
  }
}

export const notFound = (message: string): ServiceError => new ServiceError(404, message);
export const badRequest = (message: string, details?: unknown): ServiceError =>
  new ServiceError(400, message, details);
