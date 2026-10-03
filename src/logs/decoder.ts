export class StreamDecoder {
  private pending: Buffer = Buffer.alloc(0);

  constructor(private readonly maxChunkBytes: number) {
    if (!Number.isInteger(maxChunkBytes) || maxChunkBytes < 1) throw new Error('Chunk size must be a positive integer.');
  }

  push(chunk: Buffer): string[] {
    if (chunk.length === 0) return [];
    this.pending = this.pending.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.pending, chunk]);
    const out: string[] = [];
    while (this.pending.length > 0) {
      const end = completeEnd(this.pending, Math.min(this.pending.length, this.maxChunkBytes));
      if (end === 0) break;
      out.push(this.pending.subarray(0, end).toString('utf8'));
      this.pending = this.pending.subarray(end);
      if (end < this.maxChunkBytes) break;
    }
    return out;
  }

  flush(): string[] {
    if (this.pending.length === 0) return [];
    const text = this.pending.toString('utf8');
    this.pending = Buffer.alloc(0);
    return text.length > 0 ? [text] : [];
  }
}

export function truncateUtf8(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text);
  if (buffer.length <= maxBytes) return text;
  const end = completeEnd(buffer, maxBytes);
  return end === 0 ? '' : buffer.subarray(0, end).toString('utf8');
}

function completeEnd(buffer: Buffer, limit: number): number {
  let position = 0;
  let good = 0;
  const end = Math.min(buffer.length, limit);
  while (position < end) {
    const length = sequenceLength(buffer[position] ?? 0);
    if (position + length > buffer.length || position + length > end) break;
    let valid = length > 1 || (buffer[position] ?? 0) < 0x80;
    if ((buffer[position] ?? 0) >= 0x80 && length === 1) valid = false;
    for (let offset = 1; offset < length; offset += 1) {
      if (((buffer[position + offset] ?? 0) & 0xc0) !== 0x80) valid = false;
    }
    if (!valid) {
      position += 1;
      good = position;
      continue;
    }
    position += length;
    good = position;
  }
  return good;
}

function sequenceLength(byte: number): number {
  if (byte < 0x80) return 1;
  if (byte >= 0xc0 && byte < 0xe0) return 2;
  if (byte >= 0xe0 && byte < 0xf0) return 3;
  if (byte >= 0xf0 && byte < 0xf8) return 4;
  return 1;
}
