import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MatchId } from '../../../../../packages/domain/src/shared/ids';
import { MatchLog } from '../../../../../packages/domain/src/competition/CompetitionTypes';
import { MatchLogStorePort } from '../../../../../packages/application/src/ports/ports';

export interface FilesystemMatchLogStoreOptions {
  /** Directory the JSON blobs land in (created on demand). */
  directory: string;
  /** When set, returned URLs are `${publicBaseUrl}/{matchId}.json`
   * (a local dev server serving the directory); otherwise file:// URLs. */
  publicBaseUrl?: string;
}

/**
 * Dev-mode implementation of the "immutable replay blob" pattern
 * (CLAUDE.md principle #4): writes each MatchLog once as a JSON file
 * and hands back a URL the frontend can GET and play back client-side.
 *
 * Deliberately the cheap local stand-in for the production
 * object-storage adapter (S3/R2 behind a CDN) — same port, same
 * write-once semantics, same shape of returned URL. Swapping in the
 * real one later is a drop-in replacement of this single class;
 * nothing that depends on MatchLogStorePort changes.
 *
 * Write-once is enforced, not just assumed: the file is opened with
 * the 'wx' exclusive flag, so a second save for the same matchId
 * fails loudly instead of silently mutating a blob that viewers may
 * already have cached — the same guarantee an object store with
 * if-none-match would give.
 */
export class FilesystemMatchLogStore implements MatchLogStorePort {
  constructor(private readonly options: FilesystemMatchLogStoreOptions) {}

  async save(matchId: MatchId, log: MatchLog): Promise<{ url: string }> {
    await mkdir(this.options.directory, { recursive: true });

    const filePath = join(this.options.directory, `${matchId}.json`);
    await writeFile(filePath, JSON.stringify(log), { flag: 'wx' });

    return { url: this.urlFor(matchId, filePath) };
  }

  private urlFor(matchId: MatchId, filePath: string): string {
    if (this.options.publicBaseUrl) {
      return `${this.options.publicBaseUrl.replace(/\/$/, '')}/${matchId}.json`;
    }
    return pathToFileURL(resolve(filePath)).href;
  }
}
