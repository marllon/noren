// `@noren/model` has no DOM or Node typings, so TextEncoder/TextDecoder are not available here.

const REPLACEMENT = 0xfffd;

/** Encodes text as UTF-8. Lone surrogates become U+FFFD. */
export function encodeUtf8(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length * 3);
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    let cp = text.charCodeAt(i);
    if (cp >= 0xd800 && cp <= 0xdbff) {
      const low = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
      if (low >= 0xdc00 && low <= 0xdfff) {
        cp = 0x10000 + ((cp - 0xd800) << 10) + (low - 0xdc00);
        i++;
      } else {
        cp = REPLACEMENT;
      }
    } else if (cp >= 0xdc00 && cp <= 0xdfff) {
      cp = REPLACEMENT;
    }
    if (cp < 0x80) {
      bytes[n++] = cp;
    } else if (cp < 0x800) {
      bytes[n++] = 0xc0 | (cp >> 6);
      bytes[n++] = 0x80 | (cp & 0x3f);
    } else if (cp < 0x10000) {
      bytes[n++] = 0xe0 | (cp >> 12);
      bytes[n++] = 0x80 | ((cp >> 6) & 0x3f);
      bytes[n++] = 0x80 | (cp & 0x3f);
    } else {
      bytes[n++] = 0xf0 | (cp >> 18);
      bytes[n++] = 0x80 | ((cp >> 12) & 0x3f);
      bytes[n++] = 0x80 | ((cp >> 6) & 0x3f);
      bytes[n++] = 0x80 | (cp & 0x3f);
    }
  }
  return bytes.slice(0, n);
}

/** Decodes UTF-8 bytes. Malformed sequences become U+FFFD. */
export function decodeUtf8(bytes: Uint8Array): string {
  let text = "";
  let i = 0;
  while (i < bytes.length) {
    const b0 = bytes[i] ?? 0;
    let need = 0;
    let cp = REPLACEMENT;
    let min = 0;
    if (b0 < 0x80) {
      cp = b0;
    } else if (b0 >= 0xc2 && b0 <= 0xdf) {
      need = 1;
      cp = b0 & 0x1f;
      min = 0x80;
    } else if (b0 >= 0xe0 && b0 <= 0xef) {
      need = 2;
      cp = b0 & 0x0f;
      min = 0x800;
    } else if (b0 >= 0xf0 && b0 <= 0xf4) {
      need = 3;
      cp = b0 & 0x07;
      min = 0x10000;
    }
    i++;
    for (let k = 0; k < need; k++) {
      const b = bytes[i] ?? 0;
      if ((b & 0xc0) !== 0x80) {
        cp = REPLACEMENT;
        break;
      }
      cp = (cp << 6) | (b & 0x3f);
      i++;
    }
    if (
      need > 0 &&
      cp !== REPLACEMENT &&
      (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff))
    ) {
      cp = REPLACEMENT;
    }
    text += String.fromCodePoint(cp);
  }
  return text;
}
