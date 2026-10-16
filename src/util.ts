import { createHash, randomBytes, randomUUID } from 'node:crypto';

/** `2026-10-01T12:00:00Z`: the envelope and public-message format (platform-gate `Event`, `PublicMessageResource`). */
export function isoSeconds(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** `2026-10-01T12:00:00.000000Z`: what Laravel writes for a date a resource does not format (Carbon `toJSON`). */
export function laravelJson(date: Date): string {
  return date.toISOString().replace(/\.(\d{3})Z$/, '.$1000Z');
}

/** `2026-10-01T12:00:00+00:00`: Carbon `toIso8601String()` in UTC (accounts resources, conversations dates). */
export function iso8601(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, '+00:00');
}

/** `2026-10-01 12:00:00`: the `time` column of the message history. */
export function sqlDateTime(date: Date): string {
  return date.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
}

/** A random event id: `evt_` + 24 hex characters, like platform-gate `Event::make()`. */
export function randomEventId(): string {
  return `evt_${randomBytes(12).toString('hex')}`;
}

/**
 * A deterministic event id for one occurrence (`evt_` + 24 hex), like conversations' `WebhookEventId::fromKey()`:
 * the same key gives the same id while the salt is the same (one sandbox session, until a reset).
 */
export function deterministicEventId(salt: string, key: string): string {
  return `evt_${createHash('sha256').update(`${salt}|${key}`).digest('hex').slice(0, 24)}`;
}

export function uuid(): string {
  return randomUUID();
}

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** `length` random characters of `[A-Za-z0-9]` (Laravel `Str::random`). */
export function randomAlnum(length: number): string {
  const bytes = randomBytes(length * 2);
  let out = '';
  for (let i = 0; out.length < length && i < bytes.length; i++) {
    const byte = bytes[i] as number;
    // 248 = 62 * 4: rejection sampling keeps the distribution uniform.
    if (byte < 248) out += ALNUM[byte % 62];
  }
  return out.length === length ? out : out + randomAlnum(length - out.length);
}

let crcTable: Uint32Array | null = null;

/** CRC-32 (the `crc32b` of PHP's `hash()`), as 8 lowercase hex characters. */
export function crc32Hex(text: string): string {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of Buffer.from(text, 'utf8')) crc = (crcTable[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0');
}

/** A webhook secret in the format of accounts: `whsec_` + 40 random characters + their crc32b. */
export function webhookSecret(): string {
  const entropy = randomAlnum(40);
  return `whsec_${entropy}${crc32Hex(entropy)}`;
}

/** Only the digits of a phone (`+54 9 11…` → `54911…`). */
export function digits(value: unknown): string {
  return String(value ?? '').replace(/\D+/g, '');
}

/** `+` and digits, or `null` (the phone format of the events). */
export function toE164(value: unknown): string | null {
  const d = digits(value);
  return d.length >= 8 ? `+${d}` : null;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Truncates a text for the panel and the logs. */
export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
