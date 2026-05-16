import { promises as fsp } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve, dirname, sep } from 'node:path';
import { ObeliskError } from '../../shared/errors';
import type { IpcMap } from '../../shared/types';

/**
 * Backs the in-app branded folder picker. The renderer can't read the
 * filesystem directly, so it asks main to list a directory. We only
 * return names + isDir + isHidden — nothing that could leak file
 * contents — and reject anything that isn't an absolute path on disk.
 */
export async function handleFsListDir(
  payload: IpcMap['fs:listDir']['req'],
): Promise<IpcMap['fs:listDir']['res']> {
  const target = (payload.path ?? homedir()).trim() || homedir();
  if (!isAbsolute(target)) {
    throw new ObeliskError('INVALID_INPUT', `Path must be absolute: ${target}`);
  }
  const resolved = resolve(target);
  let dirents;
  try {
    dirents = await fsp.readdir(resolved, { withFileTypes: true });
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === 'ENOENT') {
      throw new ObeliskError('NOT_FOUND', `Directory does not exist: ${resolved}`);
    }
    if (code === 'EACCES' || code === 'EPERM') {
      throw new ObeliskError(
        'INVALID_INPUT',
        `No permission to read: ${resolved}`,
        'Pick a folder you have access to, or grant Obelisk Full Disk Access in macOS settings.',
      );
    }
    if (code === 'ENOTDIR') {
      throw new ObeliskError('INVALID_INPUT', `Not a directory: ${resolved}`);
    }
    throw e;
  }

  const entries = dirents
    .filter((d) => d.isDirectory() || d.isSymbolicLink())
    .map((d) => ({
      name: d.name,
      isDir: true,
      isHidden: d.name.startsWith('.'),
    }))
    .filter((e) => payload.showHidden || !e.isHidden)
    .sort((a, b) => a.name.localeCompare(b.name));

  const parent = resolved === sep || dirname(resolved) === resolved ? null : dirname(resolved);

  return { path: resolved, parent, entries };
}
