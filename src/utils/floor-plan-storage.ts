import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
// src/utils -> apps/backend/src/utils -> repository root
const repositoryRoot = path.resolve(sourceDirectory, '../../../..');

/**
 * Returns one configured, absolute location for runtime-uploaded floor maps.
 * A deployment may set FLOOR_PLAN_UPLOAD_DIR; local development and services
 * launched from either repository root or apps/backend consistently use the
 * repository uploads/floors directory instead of process.cwd().
 */
export const getFloorPlanUploadDirectory = (): string => {
  const configured = process.env.FLOOR_PLAN_UPLOAD_DIR?.trim();
  if (configured) {
    return path.resolve(configured);
  }
  return path.resolve(repositoryRoot, 'uploads', 'floors');
};

/**
 * Old services wrote from the repository root or backend directory. Keep
 * those existing files readable during the GridFS transition; new uploads
 * are stored in MongoDB.
 */
export const getFloorPlanAssetDirectories = (): string[] => {
  const primary = getFloorPlanUploadDirectory();
  const legacyWorkingDirectory = path.resolve(process.cwd(), 'uploads', 'floors');
  const legacyBackendDirectory = path.resolve(repositoryRoot, 'apps', 'backend', 'uploads', 'floors');
  return [...new Set([primary, legacyWorkingDirectory, legacyBackendDirectory])];
};

export const resolveFloorPlanAssetPath = (filename: string): string | null => {
  if (!filename || filename !== path.basename(filename)) return null;
  const directory = getFloorPlanUploadDirectory();
  const resolved = path.resolve(directory, filename);
  return resolved.startsWith(`${directory}${path.sep}`) ? resolved : null;
};

export const resolveFloorPlanAssetPaths = (filename: string): string[] => {
  if (!filename || filename !== path.basename(filename)) return [];
  const directories = getFloorPlanAssetDirectories();
  return directories
    .map((directory) => path.resolve(directory, filename))
    .filter((resolved, index, values) =>
      resolved.startsWith(`${directories[index]}${path.sep}`) && values.indexOf(resolved) === index,
    );
};
