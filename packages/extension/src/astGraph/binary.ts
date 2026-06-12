/**
 * Download / cache / verify the pinned `ast-graph` CLI binary in extension
 * globalStorage. Pinned to v0.3.0 — bump AST_GRAPH_VERSION + checksums
 * together when picking up a new upstream release.
 *
 * Cache layout:
 *   <globalStorage>/ast-graph/<version>/ast-graph[.exe]
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as crypto from 'crypto';
import { execFile } from 'child_process';

export const AST_GRAPH_VERSION = '0.3.0';
const RELEASE_BASE = `https://github.com/emtyty/ast-graph/releases/download/v${AST_GRAPH_VERSION}`;

interface TargetSpec {
  asset: string;
  /** SHA256 of the archive file. */
  sha256: string;
  /** Name of the executable after extraction. */
  exe: string;
}

const TARGETS: Record<string, TargetSpec> = {
  'aarch64-apple-darwin': {
    asset: 'ast-graph-cli-aarch64-apple-darwin.tar.xz',
    sha256: 'e69a381bd8c3aafc211dd6339e4391a4779315d8c4cc8e0604960522cc456f7a',
    exe: 'ast-graph',
  },
  'x86_64-apple-darwin': {
    asset: 'ast-graph-cli-x86_64-apple-darwin.tar.xz',
    sha256: '0baac18505437da795a35cd98a53c90e819849276ef2a95edb57534d44b149f5',
    exe: 'ast-graph',
  },
  'x86_64-unknown-linux-gnu': {
    asset: 'ast-graph-cli-x86_64-unknown-linux-gnu.tar.xz',
    sha256: 'd52ae4a96bd4d6963f741b5e7118cbff5a1fd587ff089e8aed9373324e6cd7de',
    exe: 'ast-graph',
  },
  'x86_64-pc-windows-msvc': {
    asset: 'ast-graph-cli-x86_64-pc-windows-msvc.zip',
    sha256: '120f03b617b7d33f9ecc1a165602bd5c795ec53ae12b4ac109f0d5af40736497',
    exe: 'ast-graph.exe',
  },
};

export interface BinaryResolution {
  path: string;
  version: string;
}

export class UnsupportedPlatformError extends Error {
  constructor(public platform: string, public arch: string) {
    super(`ast-graph: no prebuilt binary for ${platform}/${arch}. Supported: macOS (arm64/x64), Linux (x64), Windows (x64).`);
  }
}

function detectTarget(): string {
  const { platform, arch } = process;
  if (platform === 'darwin' && arch === 'arm64') return 'aarch64-apple-darwin';
  if (platform === 'darwin' && arch === 'x64') return 'x86_64-apple-darwin';
  if (platform === 'linux' && arch === 'x64') return 'x86_64-unknown-linux-gnu';
  if (platform === 'win32' && arch === 'x64') return 'x86_64-pc-windows-msvc';
  throw new UnsupportedPlatformError(platform, arch);
}

function installDir(context: vscode.ExtensionContext): string {
  return path.join(context.globalStorageUri.fsPath, 'ast-graph', AST_GRAPH_VERSION);
}

/**
 * Return the path to the cached `ast-graph` binary, downloading and extracting it on first
 * call. Idempotent. Throws on unsupported platform, network failure, or checksum mismatch.
 *
 * When `overridePath` names an existing executable it is used verbatim — no download, no
 * checksum check. This is the supported escape hatch for platforms upstream ships no prebuilt
 * binary for (e.g. Linux arm64): install `ast-graph` yourself and point the setting at it.
 */
export async function ensureAstGraphBinary(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  overridePath?: string,
): Promise<BinaryResolution> {
  const override = overridePath?.trim();
  if (override) {
    if (!(await isFileReady(override))) {
      throw new Error(`ast-graph: configured binaryPath does not point at a file: ${override}`);
    }
    output.appendLine(`ast-graph: using configured binaryPath ${override} (download skipped)`);
    return { path: override, version: 'override' };
  }

  const target = detectTarget();
  const spec = TARGETS[target];
  const dir = installDir(context);
  const exePath = path.join(dir, spec.exe);

  if (await isFileReady(exePath)) {
    return { path: exePath, version: AST_GRAPH_VERSION };
  }

  await fs.promises.mkdir(dir, { recursive: true });
  const archivePath = uniqueArchivePath(dir, spec.asset);
  const url = `${RELEASE_BASE}/${spec.asset}`;

  output.appendLine(`ast-graph: downloading ${url}`);
  await downloadFile(url, archivePath);

  const actual = await sha256OfFile(archivePath);
  const expected = spec.sha256 || (await fetchExpectedSha(`${url}.sha256`));
  if (expected && actual.toLowerCase() !== expected.toLowerCase()) {
    await fs.promises.unlink(archivePath).catch(() => {});
    throw new Error(`ast-graph: checksum mismatch for ${spec.asset} (got ${actual}, expected ${expected})`);
  }
  output.appendLine(`ast-graph: checksum OK (${actual.slice(0, 12)}…)`);

  if (await isFileReady(exePath)) {
    await fs.promises.unlink(archivePath).catch(() => {});
    return { path: exePath, version: AST_GRAPH_VERSION };
  }

  await extractArchive(archivePath, dir, spec.exe, output);
  await fs.promises.unlink(archivePath).catch(() => {});

  if (process.platform !== 'win32') {
    await fs.promises.chmod(exePath, 0o755).catch(() => {});
  }
  if (process.platform === 'darwin') {
    // Best-effort: strip the Gatekeeper quarantine attribute on the downloaded executable.
    await runChecked('xattr', ['-dr', 'com.apple.quarantine', exePath], 5_000).catch(() => {});
  }

  if (!(await isFileReady(exePath))) {
    throw new Error(`ast-graph: executable not found after extraction at ${exePath}`);
  }

  output.appendLine(`ast-graph: installed at ${exePath}`);
  return { path: exePath, version: AST_GRAPH_VERSION };
}

async function isFileReady(p: string): Promise<boolean> {
  try {
    const st = await fs.promises.stat(p);
    return st.isFile() && st.size > 0;
  } catch {
    return false;
  }
}

function uniqueArchivePath(dir: string, asset: string): string {
  const id = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  if (asset.endsWith('.tar.xz')) {
    return path.join(dir, asset.replace(/\.tar\.xz$/, `.${id}.tar.xz`));
  }
  if (asset.endsWith('.zip')) {
    return path.join(dir, asset.replace(/\.zip$/, `.${id}.zip`));
  }
  return path.join(dir, `${asset}.${id}`);
}

/** Stream a URL to disk, following up to 5 redirects. Writes to `<dst>.part` and renames on success. */
function downloadFile(url: string, dst: string, hops = 0): Promise<void> {
  return new Promise((resolve, reject) => {
    if (hops > 5) {
      reject(new Error(`ast-graph: too many redirects fetching ${url}`));
      return;
    }
    const tmp = `${dst}.${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.part`;
    https.get(url, { headers: { 'User-Agent': 'ai-stepflow-vscode' } }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const next = new URL(res.headers.location, url).toString();
        downloadFile(next, dst, hops + 1).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`ast-graph: HTTP ${res.statusCode} fetching ${url}`));
        return;
      }

      const file = fs.createWriteStream(tmp);
      let settled = false;
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        file.close(() => {
          fs.promises.unlink(tmp).catch(() => {}).finally(() => reject(err));
        });
      };

      res.pipe(file);
      file.on('error', fail);
      file.on('finish', () => {
        file.close(() => {
          if (settled) return;
          settled = true;
          fs.promises.rename(tmp, dst).then(resolve, reject);
        });
      });
      res.on('error', fail);
    }).on('error', reject);
  });
}

async function fetchExpectedSha(url: string): Promise<string> {
  return new Promise((resolve) => {
    https.get(url, { headers: { 'User-Agent': 'ai-stepflow-vscode' } }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fetchExpectedSha(new URL(res.headers.location, url).toString()).then(resolve);
        return;
      }
      if (res.statusCode !== 200) { resolve(''); return; }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        const first = body.trim().split(/\s+/)[0] ?? '';
        resolve(first);
      });
    }).on('error', () => resolve(''));
  });
}

function sha256OfFile(p: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const s = fs.createReadStream(p);
    s.on('data', (chunk) => hash.update(chunk));
    s.on('error', reject);
    s.on('end', () => resolve(hash.digest('hex')));
  });
}

async function extractArchive(
  archive: string,
  dest: string,
  exeName: string,
  output: vscode.OutputChannel,
): Promise<void> {
  if (archive.endsWith('.zip')) {
    await runChecked(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -Path "${archive}" -DestinationPath "${dest}" -Force`],
      120_000,
    );
  } else {
    // tar.xz on macOS + Linux; archive has a top-level dir → --strip-components=1.
    await runChecked('tar', ['-xJf', archive, '-C', dest, '--strip-components=1'], 120_000);
  }

  const direct = path.join(dest, exeName);
  if (await isFileReady(direct)) return;

  const entries = await fs.promises.readdir(dest, { withFileTypes: true });
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const nested = path.join(dest, ent.name, exeName);
    if (await isFileReady(nested)) {
      await fs.promises.rename(nested, direct);
      output.appendLine(`ast-graph: lifted ${exeName} out of ${ent.name}/`);
      return;
    }
  }
}

function runChecked(cmd: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs }, (err, _stdout, stderr) => {
      if (err) {
        reject(new Error(`${cmd} failed: ${err.message}${stderr ? ` — ${stderr.toString().trim()}` : ''}`));
        return;
      }
      resolve();
    });
  });
}
