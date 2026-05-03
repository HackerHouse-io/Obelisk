import { createHash } from 'node:crypto';

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function sha256Buffer(buf: Buffer | Uint8Array): string {
  return createHash('sha256').update(buf).digest('hex');
}
