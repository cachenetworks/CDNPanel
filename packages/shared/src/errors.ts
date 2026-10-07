/**
 * Standardised API error catalogue. Every error returned by the API has the shape
 * `{ error: { code, message, request_id, details? } }`.
 */
export const ERROR_CATALOG = {
  bad_request: { status: 400, message: 'The request was malformed.' },
  validation_failed: { status: 422, message: 'One or more fields failed validation.' },
  invalid_id: { status: 400, message: 'The supplied identifier is malformed.' },
  unauthenticated: { status: 401, message: 'Authentication is required.' },
  invalid_api_key: { status: 401, message: 'The supplied API key is invalid.' },
  api_key_expired: { status: 401, message: 'The supplied API key has expired.' },
  api_key_revoked: { status: 401, message: 'The supplied API key has been revoked.' },
  api_key_disabled: { status: 401, message: 'The supplied API key is disabled.' },
  invalid_credentials: { status: 401, message: 'Invalid email or password.' },
  session_expired: { status: 401, message: 'Your session has expired. Please sign in again.' },
  mfa_required: { status: 401, message: 'A two-factor authentication code is required.' },
  invalid_mfa_code: { status: 401, message: 'The two-factor authentication code is invalid.' },
  reauthentication_required: {
    status: 403,
    message: 'This action requires you to confirm your password.',
  },
  two_factor_enrollment_required: {
    status: 403,
    message: 'Your account must enroll in two-factor authentication before continuing.',
  },
  forbidden: { status: 403, message: 'You do not have permission to perform this action.' },
  insufficient_scope: { status: 403, message: 'The API key does not have the required scope.' },
  ip_not_allowed: { status: 403, message: 'Requests from this IP address are not permitted for this API key.' },
  endpoint_not_allowed: { status: 403, message: 'This API key is not permitted to call this endpoint.' },
  staff_session_required: { status: 403, message: 'This endpoint requires a staff session.' },
  csrf_failed: { status: 403, message: 'CSRF validation failed.' },
  account_disabled: { status: 403, message: 'This account has been disabled.' },
  not_found: { status: 404, message: 'The requested resource could not be found.' },
  file_not_found: { status: 404, message: 'The requested file could not be found.' },
  folder_not_found: { status: 404, message: 'The requested folder could not be found.' },
  upload_not_found: { status: 404, message: 'The requested upload could not be found.' },
  user_not_found: { status: 404, message: 'The requested user could not be found.' },
  role_not_found: { status: 404, message: 'The requested role could not be found.' },
  api_key_not_found: { status: 404, message: 'The requested API key could not be found.' },
  webhook_not_found: { status: 404, message: 'The requested webhook could not be found.' },
  storage_provider_not_found: { status: 404, message: 'The requested storage provider could not be found.' },
  conflict: { status: 409, message: 'The request conflicts with the current state of the resource.' },
  name_conflict: { status: 409, message: 'An item with that name already exists in this folder.' },
  file_not_ready: { status: 409, message: 'The file is not available yet.' },
  invalid_signature: { status: 403, message: 'The signed URL is invalid.' },
  signature_expired: { status: 403, message: 'The signed URL has expired.' },
  file_too_large: { status: 413, message: 'The file exceeds the maximum allowed size.' },
  quota_exceeded: { status: 413, message: 'The upload would exceed the storage quota.' },
  unsupported_file_type: { status: 415, message: 'This file type is not allowed.' },
  checksum_mismatch: { status: 422, message: 'The uploaded content does not match the supplied checksum.' },
  range_not_satisfiable: { status: 416, message: 'The requested range cannot be satisfied.' },
  rate_limited: { status: 429, message: 'Too many requests. Please slow down.' },
  internal_error: { status: 500, message: 'An unexpected error occurred.' },
  storage_error: { status: 502, message: 'The storage backend returned an error.' },
  service_unavailable: { status: 503, message: 'The service is temporarily unavailable.' },
} as const satisfies Record<string, { status: number; message: string }>;

export type ErrorCode = keyof typeof ERROR_CATALOG;

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: ErrorCode, message?: string, details?: unknown) {
    super(message ?? ERROR_CATALOG[code].message);
    this.name = 'AppError';
    this.code = code;
    this.status = ERROR_CATALOG[code].status;
    this.details = details;
  }
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    request_id?: string;
    details?: unknown;
  };
}
