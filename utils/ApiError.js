// Error carrying an HTTP status. Messages of ApiErrors are safe to show to users.
export default class ApiError extends Error {
    constructor(statusCode, message, errors) {
        super(message);
        this.statusCode = statusCode;
        this.errors = errors;
    }

    static badRequest(message = 'Bad request', errors) { return new ApiError(400, message, errors); }
    static unauthorized(message = 'Please log in to continue') { return new ApiError(401, message); }
    static forbidden(message = 'You do not have permission to do that') { return new ApiError(403, message); }
    static notFound(message = 'Resource not found') { return new ApiError(404, message); }
    static conflict(message = 'Resource already exists') { return new ApiError(409, message); }
    static unprocessable(message = 'Validation failed', errors) { return new ApiError(422, message, errors); }
}
