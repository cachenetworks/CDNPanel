import net from 'node:net';
import type { Readable } from 'node:stream';

/**
 * Malware scanning interface. The ClamAV implementation talks to clamd's INSTREAM command
 * over TCP; additional scanners can implement `MalwareScanner`.
 */
export interface ScanResult {
  clean: boolean;
  signature?: string;
  engine: string;
}

export interface MalwareScanner {
  readonly name: string;
  scan(stream: Readable): Promise<ScanResult>;
  ping(): Promise<boolean>;
}

export class ClamAvScanner implements MalwareScanner {
  readonly name = 'clamav';

  constructor(private readonly host: string, private readonly port: number, private readonly timeoutMs = 120_000) {}

  ping(): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = net.createConnection({ host: this.host, port: this.port });
      socket.setTimeout(5000);
      let data = '';
      socket.on('connect', () => socket.write('zPING\0'));
      socket.on('data', (d) => (data += d.toString()));
      socket.on('end', () => resolve(data.startsWith('PONG')));
      socket.on('timeout', () => {
        socket.destroy();
        resolve(false);
      });
      socket.on('error', () => resolve(false));
    });
  }

  scan(stream: Readable): Promise<ScanResult> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.host, port: this.port });
      socket.setTimeout(this.timeoutMs);
      let response = '';
      let settled = false;
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        stream.destroy();
        socket.destroy();
        reject(err);
      };
      socket.on('timeout', () => fail(new Error('ClamAV scan timed out')));
      socket.on('error', fail);
      socket.on('data', (d) => (response += d.toString()));
      socket.on('end', () => {
        if (settled) return;
        settled = true;
        const text = response.replace(/\0/g, '').trim();
        if (text.endsWith('OK')) resolve({ clean: true, engine: this.name });
        else if (text.endsWith('FOUND')) {
          const sig = text.replace(/^stream:\s*/, '').replace(/\s*FOUND$/, '');
          resolve({ clean: false, signature: sig, engine: this.name });
        } else reject(new Error(`Unexpected ClamAV response: ${text.slice(0, 200)}`));
      });
      socket.on('connect', () => {
        socket.write('zINSTREAM\0');
        stream.on('data', (chunk: Buffer) => {
          const size = Buffer.alloc(4);
          size.writeUInt32BE(chunk.length, 0);
          if (!socket.write(Buffer.concat([size, chunk]))) {
            stream.pause();
            socket.once('drain', () => stream.resume());
          }
        });
        stream.on('end', () => socket.write(Buffer.from([0, 0, 0, 0])));
        stream.on('error', fail);
      });
    });
  }
}

export function scannerFromEnv(host: string | undefined, port: number): MalwareScanner | null {
  return host ? new ClamAvScanner(host, port) : null;
}
