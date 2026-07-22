import type { ApiErrorBody } from "./types.js";

export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retriable = false,
    public readonly operationId?: string,
    public readonly details?: Record<string, unknown>,
    public readonly statusCode = 400
  ) {
    super(message);
    this.name = "AppError";
  }

  toJSON(): ApiErrorBody {
    return {
      code: this.code,
      message: this.message,
      retriable: this.retriable,
      ...(this.operationId ? { operationId: this.operationId } : {}),
      ...(this.details ? { details: this.details } : {})
    };
  }
}

export function asAppError(error: unknown, fallbackCode = "INTERNAL_ERROR"): AppError {
  if (error instanceof AppError) return error;
  const message = error instanceof Error ? error.message : "Unexpected error";
  return new AppError(fallbackCode, message, false, undefined, undefined, 500);
}
