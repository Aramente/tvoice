// A bounded ring buffer for recent terminal output, used to replay context
// when a client reconnects after a disconnect.

export class RingBuffer {
  constructor(maxBytes) {
    this.maxBytes = maxBytes;
    this.chunks = [];
    this.totalBytes = 0;
  }

  push(data) {
    // data is a string or Buffer
    const chunk = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
    this.chunks.push(chunk);
    this.totalBytes += chunk.length;
    while (this.totalBytes > this.maxBytes && this.chunks.length > 1) {
      const dropped = this.chunks.shift();
      this.totalBytes -= dropped.length;
    }
  }

  snapshot() {
    if (this.chunks.length === 0) return '';
    return Buffer.concat(this.chunks, this.totalBytes).toString('utf8');
  }

  clear() {
    this.chunks = [];
    this.totalBytes = 0;
  }
}
