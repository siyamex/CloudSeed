import net from 'node:net';

/**
 * A stand-in for ClamAV's `clamd`, speaking its real INSTREAM protocol over TCP:
 *   client:  "zINSTREAM\0", then repeated [4-byte big-endian length][data], then a zero length
 *   server:  "stream: OK\0"  |  "stream: <Signature> FOUND\0"  |  "INSTREAM size limit exceeded. ERROR\0"
 * It "detects" the standard EICAR test string (and anything containing the word FAKEVIRUS), so tests exercise the whole path
 * without a real antivirus engine or real malware.
 */
export const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

export interface FakeClamd {
  port: number;
  /** Number of files scanned. */
  scans: number;
  /** Bytes received for the most recent scan. */
  lastBytes: number;
  maxStream: number;
  failNext(mode: 'drop' | 'error' | 'slow'): void;
  close(): Promise<void>;
}

export async function startFakeClamd(opts: { maxStream?: number } = {}): Promise<FakeClamd> {
  let fail: 'drop' | 'error' | 'slow' | null = null;
  const state = { scans: 0, lastBytes: 0 };
  const maxStream = opts.maxStream ?? 25 * 1024 * 1024;
  const server = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    let started = false;
    const data: Buffer[] = [];
    let total = 0;
    sock.on('error', () => undefined);
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!started) {
        const nul = buf.indexOf(0);
        if (nul < 0) return;
        const cmd = buf.subarray(0, nul).toString();
        buf = buf.subarray(nul + 1);
        if (cmd === 'zPING') { sock.end('PONG\0'); return; }
        if (cmd !== 'zINSTREAM') { sock.end('UNKNOWN COMMAND\0'); return; }
        started = true;
        if (fail === 'drop') { fail = null; sock.destroy(); return; }
      }
      for (;;) {
        if (buf.length < 4) return;
        const len = buf.readUInt32BE(0);
        if (len === 0) { // end of stream: decide
          const body = Buffer.concat(data).toString('latin1');
          state.scans++; state.lastBytes = total;
          if (fail === 'error') { fail = null; sock.end('stream: Some internal error ERROR\0'); return; }
          const reply = () => {
            if (total > maxStream) sock.end('INSTREAM size limit exceeded. ERROR\0');
            else if (body.includes(EICAR)) sock.end('stream: Eicar-Test-Signature FOUND\0');
            else if (body.includes('FAKEVIRUS')) sock.end('stream: Fake.Virus.Test FOUND\0');
            else sock.end('stream: OK\0');
          };
          if (fail === 'slow') { fail = null; setTimeout(reply, 1500); } else reply();
          return;
        }
        if (buf.length < 4 + len) return;
        data.push(buf.subarray(4, 4 + len));
        total += len;
        buf = buf.subarray(4 + len);
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as net.AddressInfo).port;
  return {
    port, maxStream,
    get scans() { return state.scans; },
    get lastBytes() { return state.lastBytes; },
    failNext(mode) { fail = mode; },
    close: () => new Promise((r) => { server.close(() => r()); server.closeAllConnections?.(); }),
  };
}
