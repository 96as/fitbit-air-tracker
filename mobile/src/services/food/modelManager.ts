import { Directory, DownloadTask, File, Paths } from 'expo-file-system';
import * as Network from 'expo-network';
import { create } from 'zustand';
import { FoodFileUtils } from '../../../modules/food-file-utils';
import { useFoodStore } from '../../foodStore';
import { modelById, modelBytes, type VisionModel } from './models';

/**
 * Downloads, verifies, stores and deletes the on-device vision model.
 *
 * - Only on explicit user tap (the UI shows the size and recommends Wi-Fi).
 * - Resumable: pause → resume data is persisted, so a pause survives an app
 *   restart; a file already complete on disk is never downloaded again.
 * - Verified: SHA-256 of each file must equal the Hugging Face LFS oid.
 * - Stored in <Documents>/models/<id>/ and flagged "do not back up", so the
 *   multi-GB model never lands in iCloud backups.
 */

export type ModelStatus = 'idle' | 'downloading' | 'paused' | 'verifying' | 'error';

interface RuntimeState {
  status: ModelStatus;
  modelId?: string;
  bytesDone: number;
  bytesTotal: number;
  message?: string;
}

export const useModelRuntime = create<RuntimeState>(() => ({ status: 'idle', bytesDone: 0, bytesTotal: 0 }));

let activeTask: DownloadTask | undefined;
let cancelled = false;

export function modelDir(id: string): Directory {
  return new Directory(Paths.document, 'models', id);
}

export function modelFiles(m: VisionModel): [File, File] {
  const dir = modelDir(m.id);
  return [new File(dir, m.files[0].name), new File(dir, m.files[1].name)];
}

/** Installed = recorded as verified AND both files still on disk at the right size. */
export function isModelInstalled(id: string): boolean {
  if (!useFoodStore.getState().installed[id]) return false;
  const m = modelById(id);
  return modelFiles(m).every((f, i) => f.exists && f.size === m.files[i]!.bytes);
}

/** Paths for llama.rn (plain file paths, no scheme). */
export function modelPaths(id: string): { model: string; mmproj: string } {
  const [model, mmproj] = modelFiles(modelById(id));
  return { model: model.uri.replace(/^file:\/\//, ''), mmproj: mmproj.uri.replace(/^file:\/\//, '') };
}

export async function isOnCellular(): Promise<boolean> {
  try {
    const s = await Network.getNetworkStateAsync();
    return s.type === Network.NetworkStateType.CELLULAR;
  } catch {
    return false;
  }
}

/** Bytes still to download (files already complete on disk are skipped). */
export function remainingBytes(m: VisionModel): number {
  return modelFiles(m).reduce((sum, f, i) => sum + (f.exists && f.size === m.files[i]!.bytes ? 0 : m.files[i]!.bytes), 0);
}

export function hasRoomFor(m: VisionModel): boolean {
  try {
    return Paths.availableDiskSpace > remainingBytes(m) + 500 * 1024 * 1024;
  } catch {
    return true;
  }
}

async function excludeFromBackup(uri: string): Promise<void> {
  try {
    await FoodFileUtils?.setExcludedFromBackup(uri, true);
  } catch {
    // best effort — never block the feature on this
  }
}

/** Start (or continue) downloading `modelId`. Resolves when installed, paused or failed. */
export async function downloadModel(modelId: string): Promise<void> {
  const m = modelById(modelId);
  const store = useFoodStore.getState();
  if (activeTask) return;
  cancelled = false;
  const dir = modelDir(m.id);
  dir.create({ intermediates: true, idempotent: true });
  await excludeFromBackup(dir.uri);
  const files = modelFiles(m);
  const total = modelBytes(m);
  const doneBefore = (i: number) => m.files.slice(0, i).reduce((s, f) => s + f.bytes, 0);
  useModelRuntime.setState({ status: 'downloading', modelId, bytesTotal: total, bytesDone: total - remainingBytes(m), message: undefined });

  try {
    for (let i = 0; i < 2; i++) {
      const spec = m.files[i]!;
      const file = files[i]!;
      if (file.exists && file.size === spec.bytes) continue;
      const pending = store.pendingDownload?.modelId === modelId && store.pendingDownload.fileIndex === i ? store.pendingDownload.pause : undefined;
      const onProgress = ({ bytesWritten }: { bytesWritten: number }) =>
        useModelRuntime.setState({ bytesDone: doneBefore(i) + bytesWritten });
      let result: File | null;
      if (pending) {
        try {
          activeTask = DownloadTask.fromSavable(pending, { onProgress });
          useFoodStore.getState().setPendingDownload({ modelId, fileIndex: i });
          result = await activeTask.resumeAsync();
        } catch {
          // stale resume data (e.g. server rotated the CDN URL) → restart this file
          if (file.exists) file.delete();
          activeTask = new DownloadTask(spec.url, file, { onProgress });
          result = await activeTask.downloadAsync();
        }
      } else {
        if (file.exists) file.delete();
        activeTask = new DownloadTask(spec.url, file, { onProgress });
        useFoodStore.getState().setPendingDownload({ modelId, fileIndex: i });
        result = await activeTask.downloadAsync();
      }
      if (result === null) {
        // paused: pauseModelDownload() already persisted the resume data
        activeTask = undefined;
        useModelRuntime.setState({ status: 'paused' });
        return;
      }
      activeTask = undefined;
      if (cancelled) return;
      if (file.size !== spec.bytes) throw new Error(`${spec.name}: got ${file.size} bytes, expected ${spec.bytes}`);
    }

    useModelRuntime.setState({ status: 'verifying', message: 'Checking file integrity (SHA-256)…' });
    for (let i = 0; i < 2; i++) {
      const spec = m.files[i]!;
      const file = files[i]!;
      if (FoodFileUtils) {
        const hash = await FoodFileUtils.sha256File(file.uri);
        if (hash.toLowerCase() !== spec.sha256) {
          file.delete();
          throw new Error(`${spec.name} failed the integrity check and was deleted — please download again.`);
        }
      }
      await excludeFromBackup(file.uri);
    }
    useFoodStore.getState().setInstalled({ id: m.id, installedAtUtc: new Date().toISOString(), bytes: total });
    useFoodStore.getState().setPendingDownload(undefined);
    useModelRuntime.setState({
      status: 'idle',
      message: FoodFileUtils ? undefined : 'Installed (size-checked only: checksum helper unavailable in this build).',
    });
  } catch (err) {
    activeTask = undefined;
    if (cancelled) return;
    useModelRuntime.setState({ status: 'error', message: err instanceof Error ? err.message : String(err) });
  }
}

export async function pauseModelDownload(): Promise<void> {
  const task = activeTask;
  if (!task) return;
  await task.pauseAsync();
  const p = useFoodStore.getState().pendingDownload;
  if (p) useFoodStore.getState().setPendingDownload({ ...p, pause: task.savable() });
}

export function cancelModelDownload(modelId: string): void {
  cancelled = true;
  activeTask?.cancel();
  activeTask = undefined;
  useFoodStore.getState().setPendingDownload(undefined);
  deleteModel(modelId);
  useModelRuntime.setState({ status: 'idle', bytesDone: 0, message: undefined });
}

export function deleteModel(modelId: string): void {
  const dir = modelDir(modelId);
  try {
    if (dir.exists) dir.delete();
  } catch {
    // ignore
  }
  useFoodStore.getState().setInstalled(undefined, modelId);
}
