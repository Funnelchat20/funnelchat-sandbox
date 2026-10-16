/**
 * The signature vectors of the developer portal, replicated case by case.
 *
 * Source: developers-portal `tests/test_firmas.py` (branch feat/armar-funnelchat-portal @ dd7cd42;
 * identical in feat/openapi-unificada @ 0ef4abb), which tests `snippets/verificar-firma.js`,
 * `verificar-firma.php` and `verificar_firma.py`. Same secret, same body bytes, same cases.
 * The secret is a test value published in the portal, not a real one.
 */
import { createHmac } from 'node:crypto';

export const SECRET = 'whsec_prueba_9f3a1c7e5b2d4a6c8e0f1a3b5c7d9e1f';

/** `json.dumps(..., ensure_ascii=False, separators=(",", ":"))` of the portal's example event. */
export const BODY = Buffer.from(
  '{"id":"evt_000000000000000000000001","type":"message.received","version":1,"occurred_at":"2026-10-01T12:00:00Z","data":{"message":{"id":1001,"type":"text","text":"Hola, quiero más información","media":null},"contact":{"id":2001,"name":"Contacto de ejemplo","phone":"+5491100000000"},"receiver":{"phone":"+5491100000001"}}}',
  'utf8',
);

/** `firmar()` of test_firmas.py. */
export function sign(body: Buffer, secret: string, t: number): string {
  const v1 = createHmac('sha256', secret).update(Buffer.concat([Buffer.from(`${t}.`, 'ascii'), body])).digest('hex');
  return `t=${t},v1=${v1}`;
}

export interface SignatureCase {
  name: string;
  body: Buffer;
  header: string;
  secret: string;
  expected: boolean;
}

/** `casos()` of test_firmas.py, for a given current time `t`. */
export function portalCases(t: number): SignatureCase[] {
  const ok = sign(BODY, SECRET, t);
  const v1 = ok.split('v1=')[1] as string;
  const v1Altered = (v1[0] !== '0' ? '0' : '1') + v1.slice(1);
  const alteredBody = Buffer.from(BODY.toString('utf8').replace('Hola', 'Hole'), 'utf8');
  const reserialized = Buffer.from(JSON.stringify(JSON.parse(BODY.toString('utf8')), null, 2), 'utf8');
  const utf8Body = Buffer.from('{"texto":"Ñandú 🚀 — acentos: áéíóú"}', 'utf8');
  const secretWithoutPrefix = '9f3a1c7e5b2d4a6c8e0f1a3b5c7d9e1f';
  return [
    { name: 'firma correcta', body: BODY, header: ok, secret: SECRET, expected: true },
    { name: 'cuerpo alterado (un carácter)', body: alteredBody, header: ok, secret: SECRET, expected: false },
    { name: 'cuerpo re-serializado (mismo JSON, otros espacios)', body: reserialized, header: ok, secret: SECRET, expected: false },
    { name: 'firma alterada (un dígito)', body: BODY, header: `t=${t},v1=${v1Altered}`, secret: SECRET, expected: false },
    { name: 'secreto equivocado', body: BODY, header: ok, secret: `${SECRET}x`, expected: false },
    { name: 'timestamp alterado en la cabecera', body: BODY, header: `t=${t + 1},v1=${v1}`, secret: SECRET, expected: false },
    { name: 'timestamp viejo (hace 10 min), bien firmado', body: BODY, header: sign(BODY, SECRET, t - 600), secret: SECRET, expected: false },
    { name: 'cabecera mal formada', body: BODY, header: `sha256=${v1}`, secret: SECRET, expected: false },
    { name: 'cabecera sin v1', body: BODY, header: `t=${t}`, secret: SECRET, expected: false },
    { name: 'cabecera vacía', body: BODY, header: '', secret: SECRET, expected: false },
    { name: 'cuerpo UTF-8 (ñ, emoji) firmado sobre los bytes crudos', body: utf8Body, header: sign(utf8Body, SECRET, t), secret: SECRET, expected: true },
    { name: 'secreto sin prefijo whsec_ (se usa tal cual)', body: BODY, header: sign(BODY, secretWithoutPrefix, t), secret: secretWithoutPrefix, expected: true },
    { name: 'secreto con prefijo recortado por error', body: BODY, header: ok, secret: SECRET.replace(/^whsec_/, ''), expected: false },
  ];
}

/**
 * Fixed vectors computed independently with Python's `hmac` (not with this SDK) at t = 1790856000
 * (2026-10-01T12:00:00Z), to pin the algorithm itself.
 */
export const FIXED_T = 1790856000;
export const FIXED_VECTORS = {
  body: 'c78b061f77e36cc12c72392f1507bf147bd55c0d90848ef8dab47769607aeb44',
  bodyWithSecretWithoutPrefix: '903a0477d8b423f83ce85c3936bbe4b8682011df1355e3f4660098edcb0fad6f',
  utf8Body: 'af96d19b25835145e88625eaf33ba41f72cd0c25e741918340db190e7c98e213',
} as const;
