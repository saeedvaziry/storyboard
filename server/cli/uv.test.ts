import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { Task } from './ui';
import { downloadVerified } from './uv';

describe('downloadVerified', () => {
  const body = 'a pinned archive';
  const task = { progress() {} } as unknown as Task;
  let server: http.Server;
  let url: string;
  let dir: string;

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'storyboard-download-'));
    server = http.createServer((req, res) => {
      if (req.url === '/stalls') {
        res.writeHead(200).write(body); // Never ends.
        return;
      }
      res.writeHead(req.url === '/archive' ? 200 : 404).end(body);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(() => {
    server.closeAllConnections();
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('keeps a file that matches its checksum', async () => {
    const file = path.join(dir, 'good');
    await downloadVerified(`${url}/archive`, createHash('sha256').update(body).digest('hex'), file, task);
    assert.equal(fs.readFileSync(file, 'utf8'), body);
  });

  it('rejects a file that does not match its checksum', async () => {
    await assert.rejects(downloadVerified(`${url}/archive`, '0'.repeat(64), path.join(dir, 'bad'), task), /checksum/);
  });

  it('gives up on a download that stalls', async () => {
    await assert.rejects(downloadVerified(`${url}/stalls`, '0'.repeat(64), path.join(dir, 'stalled'), task, 50), /stalled/);
  });

  it('rejects a failed download', async () => {
    await assert.rejects(downloadVerified(`${url}/missing`, '0'.repeat(64), path.join(dir, 'missing'), task), /HTTP 404/);
  });
});
