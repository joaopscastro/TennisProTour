import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MatchId } from '@tennis-manager/domain';
import { MatchLog } from '@tennis-manager/domain';
import { MatchLogStorePort } from '@tennis-manager/application';

export interface FilesystemMatchLogStoreOptions {
  /** Base directory the per-world blob subdirectories land in (created
   * on demand). All files live under `<directory>/<worldId>`. */
  directory: string;
  /** The world this store reads/writes. Scoping on disk means two
   * worlds sharing one MATCH_LOG_DIR can never serve each other's
   * blobs for a colliding match id (match ids are deterministic —
   * `tournamentId-round-index`). */
  worldId: string;
  /** When set, returned URLs are `${publicBaseUrl}/{matchId}.json`
   * (a local dev server serving the directory); otherwise file:// URLs.
   * The public URL deliberately does NOT include the world id — the API
   * resolves the world subdirectory internally when serving it (see
   * app.ts), so the URL a manager sees is unchanged across worlds. */
  publicBaseUrl?: string;
}

/**
 * Dev-mode implementation of the "immutable replay blob" pattern
 * (CLAUDE.md principle #4): writes each MatchLog as a JSON file and
 * hands back a URL the frontend can GET and play back client-side.
 *
 * Deliberately the cheap local stand-in for the production
 * object-storage adapter (S3/R2 behind a CDN) — same port, same shape
 * of returned URL. Swapping in the real one later is a drop-in
 * replacement of this single class; nothing that depends on
 * MatchLogStorePort changes.
 *
 * WRITES ARE ATOMIC AND OVERWRITING, not write-once. The original
 * adapter opened the target with the 'wx' exclusive flag, which threw
 * `EEXIST` whenever a blob for the match id already existed. Match ids
 * are deterministic (`tournamentId-round-index`), so a re-simulated
 * match, a re-bootstrapped fixed-id demo draw, or a second world
 * sharing one MATCH_LOG_DIR all tripped it — the throw made the day
 * tick count the match as "failed" even though its outcome was already
 * committed to the database, and the API then served the STALE blob,
 * so the replay could disagree with the recorded score. The property
 * write-once was actually protecting is "a reader never sees a partial
 * file", and a write to a temp file in the same directory followed by
 * an atomic `rename` over the target provides exactly that — while
 * letting a re-simulated match's replay reflect the currently
 * committed outcome. (Atomic rename is why the temp file must share
 * the directory: a rename across filesystems is not atomic.)
 *
 * LAYOUT IS PER-WORLD: blobs live at `<directory>/<worldId>/…`, so two
 * worlds pointed at the same MATCH_LOG_DIR cannot collide on a shared
 * deterministic id. The public URL is unaffected — the HTTP layer
 * resolves the world subdirectory internally.
 */
export class FilesystemMatchLogStore implements MatchLogStorePort {
  constructor(private readonly options: FilesystemMatchLogStoreOptions) {}

  async save(matchId: MatchId, log: MatchLog): Promise<{ url: string }> {
    await mkdir(this.worldDirectory, { recursive: true });

    const filePath = this.filePathFor(matchId);
    // Unique temp name so two concurrent saves for the same id can't
    // clobber each other's temp file; the last atomic rename wins,
    // which is fine — same outcome, no partial read either way.
    const tempPath = join(this.worldDirectory, `.${matchId}.${randomUUID()}.tmp`);
    await writeFile(tempPath, JSON.stringify(log));
    try {
      await rename(tempPath, filePath);
    } catch (error) {
      // A failed rename (e.g. a permissions error) must not leave a
      // stray temp file behind for the next save to trip over.
      await rm(tempPath, { force: true });
      throw error;
    }

    return { url: this.urlFor(matchId, filePath) };
  }

  async read(matchId: MatchId): Promise<string> {
    return readFile(this.filePathFor(matchId), 'utf8');
  }

  private get worldDirectory(): string {
    return join(this.options.directory, this.options.worldId);
  }

  private filePathFor(matchId: MatchId): string {
    return join(this.worldDirectory, `${matchId}.json`);
  }

  private urlFor(matchId: MatchId, filePath: string): string {
    if (this.options.publicBaseUrl) {
      return `${this.options.publicBaseUrl.replace(/\/$/, '')}/${matchId}.json`;
    }
    return pathToFileURL(resolve(filePath)).href;
  }
}
