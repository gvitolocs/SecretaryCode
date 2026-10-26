/** Input from the renderer, a stored file or the helper that failed validation at its boundary. */
export class RecorderInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "RecorderInputError"
  }
}

export function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new RecorderInputError(`${name} must be an object`)

  // SAFETY: checked above to be a non-array object; callers read its fields as unknown.
  return value as Record<string, unknown>
}

export function field(value: Record<string, unknown>, key: string) {
  return Object.hasOwn(value, key) && value[key] !== undefined
}

export function text(value: unknown, name: string, max = 500) {
  if (typeof value !== "string" || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value))
    throw new RecorderInputError(`${name} must be text of up to ${max} characters`)

  return value
}

export function optionalText(value: unknown, name: string, max = 500) {
  return value === undefined || value === null ? null : text(value, name, max)
}

export function finite(value: unknown, name: string) {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new RecorderInputError(`${name} must be a number`)

  return value
}
