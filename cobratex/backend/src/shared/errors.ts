export class AppError extends Error {
  status = 400;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export class NotFoundError extends AppError {
  constructor(message: string) {
    super(message, 404);
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super(message, 409);
  }
}

export class ValidationError extends AppError {
  constructor(message: string) {
    super(message, 422);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'غير مصرَّح') {
    super(message, 401);
  }
}
