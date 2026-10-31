/** Decode inline base64 image URIs (markdown or bare) without passing binary as prompt text. */
export function extractInlineDataImages(text: string): { text: string; images: Array<{ mime: string; bytes: Uint8Array; offset: number }> } {
  const images: Array<{ mime: string; bytes: Uint8Array; offset: number }> = [];
  const pattern = /!?\[[^\]]*\]\(\s*data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)\s*\)|data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)/gi;
  let out = '', last = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    const mime = match[1] || match[3];
    const base64 = (match[2] || match[4] || '').replace(/\s+/g, '');
    let bytes: Uint8Array;
    try {
      const binary = atob(base64);
      bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    } catch { continue; }
    out += text.slice(last, start);
    images.push({ mime, bytes, offset: out.length });
    last = start + match[0].length;
  }
  out += text.slice(last);
  return { text: out, images };
}

