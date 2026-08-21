/**
 * Secret redaction.
 *
 * A provider error can quote the request that caused it, and that request
 * carries the Authorization header. That text was flowing into drama events,
 * onto the screen, and into the recorded run JSON on disk — the exact files
 * you would hand someone to show off a run.
 *
 * So everything is scrubbed at the event bus, which is the one place every
 * observable string passes through: the UI, the recordings and the console all
 * read from it. Redacting at each call site would mean getting every call site
 * right forever; redacting at the choke point means getting it right once.
 */

const PATTERNS: RegExp[] = [
  /sk-or-v1-[A-Za-z0-9_-]{8,}/g, // OpenRouter
  /sk-ant-[A-Za-z0-9_-]{8,}/g, // Anthropic
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, // any Authorization header value
];

/** Values that must never appear in output, whatever shape they arrive in. */
function liveSecrets(): string[] {
  return [process.env.OPENROUTER_API_KEY, process.env.ANTHROPIC_API_KEY]
    .filter((v): v is string => typeof v === 'string' && v.trim().length >= 8)
    .map((v) => v.trim());
}

export function redact(text: string): string {
  let out = text;

  // Exact known values first. The patterns below rewrite the text, and a
  // partial match can chop a mangled key in half so that an exact search for
  // it afterwards finds nothing and the remainder survives.
  for (const secret of liveSecrets()) {
    if (out.includes(secret)) out = out.split(secret).join('<redacted>');
  }

  for (const pattern of PATTERNS) out = out.replace(pattern, (m) => `${m.slice(0, 12)}…<redacted>`);
  return out;
}

/** Redact every string inside a value, preserving its shape. */
export function redactDeep<T>(value: T): T {
  if (typeof value === 'string') return redact(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[key] = redactDeep(inner);
    }
    return out as T;
  }
  return value;
}
