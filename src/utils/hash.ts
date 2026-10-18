/**
 * Hashing and Image Fingerprinting utilities
 */

export async function sha256(data: ArrayBuffer | Uint8Array | string): Promise<string> {
  let buffer: Uint8Array;
  if (typeof data === 'string') {
    buffer = new TextEncoder().encode(data);
  } else if (data instanceof ArrayBuffer) {
    buffer = new Uint8Array(data);
  } else {
    buffer = data;
  }

  // Web Crypto API is standard in modern browsers and Node 18+
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const hashBuffer = await crypto.subtle.digest('SHA-256', buffer as any);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  // Fallback simple 32-bit FNV-1a if subtle crypto is unavailable in rare environments
  let hash = 2166136261;
  for (let i = 0; i < buffer.length; i++) {
    hash ^= buffer[i];
    hash = Math.imul(hash, 16777619);
  }
  return ('0000000' + (hash >>> 0).toString(16)).slice(-8);
}

/**
 * 64-bit Difference Hash (dHash) for image deduplication
 * Compares adjacent pixels on a 9x8 grayscale downscale
 */
export async function computeImageDHash(canvasOrBitmap: HTMLCanvasElement | ImageBitmap): Promise<string> {
  try {
    const offscreen = document.createElement('canvas');
    offscreen.width = 9;
    offscreen.height = 8;
    const ctx = offscreen.getContext('2d', { willReadFrequently: true });
    if (!ctx) return '0000000000000000';

    ctx.drawImage(canvasOrBitmap, 0, 0, 9, 8);
    const imgData = ctx.getImageData(0, 0, 9, 8);
    const data = imgData.data;

    let hashBinary = '';
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const idx1 = (y * 9 + x) * 4;
        const idx2 = (y * 9 + (x + 1)) * 4;
        // Grayscale luminance
        const gray1 = data[idx1] * 0.299 + data[idx1 + 1] * 0.587 + data[idx1 + 2] * 0.114;
        const gray2 = data[idx2] * 0.299 + data[idx2 + 1] * 0.587 + data[idx2 + 2] * 0.114;
        hashBinary += gray1 < gray2 ? '1' : '0';
      }
    }

    // Convert 64-bit binary to 16 hex chars
    let hex = '';
    for (let i = 0; i < 64; i += 4) {
      hex += parseInt(hashBinary.slice(i, i + 4), 2).toString(16);
    }
    return hex;
  } catch {
    return '0000000000000000';
  }
}

/**
 * Calculate Hamming distance between two hex hashes
 */
export function hammingDistance(hash1: string, hash2: string): number {
  let dist = 0;
  for (let i = 0; i < Math.min(hash1.length, hash2.length); i++) {
    const v1 = parseInt(hash1[i], 16);
    const v2 = parseInt(hash2[i], 16);
    let xor = v1 ^ v2;
    while (xor > 0) {
      dist += xor & 1;
      xor >>= 1;
    }
  }
  return dist + Math.abs(hash1.length - hash2.length) * 4;
}

/**
 * Check if a canvas/image is near uniform color (borders, logos, blank spaces)
 */
export function isNearUniformColor(canvas: HTMLCanvasElement): boolean {
  try {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return false;
    const { width, height } = canvas;
    if (width < 1 || height < 1) return true;

    // Sample 25 points
    const stepX = Math.max(1, Math.floor(width / 6));
    const stepY = Math.max(1, Math.floor(height / 6));
    let minR = 255, maxR = 0;
    let minG = 255, maxG = 0;
    let minB = 255, maxB = 0;

    for (let x = Math.min(stepX, width - 1); x < width; x += stepX) {
      for (let y = Math.min(stepY, height - 1); y < height; y += stepY) {
        const pixel = ctx.getImageData(x, y, 1, 1).data;
        minR = Math.min(minR, pixel[0]);
        maxR = Math.max(maxR, pixel[0]);
        minG = Math.min(minG, pixel[1]);
        maxG = Math.max(maxG, pixel[1]);
        minB = Math.min(minB, pixel[2]);
        maxB = Math.max(maxB, pixel[2]);
      }
    }

    // If color variance across sampled points is minimal
    const range = Math.max(maxR - minR, maxG - minG, maxB - minB);
    return range < 8;
  } catch {
    return false;
  }
}
