/**
 * Isomorphic base64url (RFC 4648 §5, unpadded) for UTF-8 text. Uses only
 * `TextEncoder`/`TextDecoder`, available in Node.js and browsers.
 *
 * @internal
 */

const ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

const LOOKUP = new Map<string, number>(
  Array.from(ALPHABET, (char, index) => [char, index]),
);

/** Encodes UTF-8 text as unpadded base64url. */
export function encodeBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let output = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const b0 = bytes[index] ?? 0;
    const b1 = bytes[index + 1];
    const b2 = bytes[index + 2];
    const chunk = (b0 << 16) | ((b1 ?? 0) << 8) | (b2 ?? 0);
    output += ALPHABET.charAt((chunk >> 18) & 63);
    output += ALPHABET.charAt((chunk >> 12) & 63);
    if (b1 !== undefined) output += ALPHABET.charAt((chunk >> 6) & 63);
    if (b2 !== undefined) output += ALPHABET.charAt(chunk & 63);
  }
  return output;
}

/**
 * Decodes unpadded base64url into UTF-8 text.
 *
 * @returns the text, or `null` when the input is not valid base64url / UTF-8.
 */
export function decodeBase64Url(encoded: string): string | null {
  if (encoded.length % 4 === 1) return null;
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of encoded) {
    const value = LOOKUP.get(char);
    if (value === undefined) return null;
    buffer = ((buffer << 6) | value) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(
      Uint8Array.from(bytes),
    );
  } catch {
    return null;
  }
}
