import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getFloorPlanUploadDirectory, resolveFloorPlanAssetPath } from '../src/utils/floor-plan-storage.js';

describe('floor-plan storage root', () => {
  const original = process.env.FLOOR_PLAN_UPLOAD_DIR;

  afterEach(() => {
    if (original === undefined) delete process.env.FLOOR_PLAN_UPLOAD_DIR;
    else process.env.FLOOR_PLAN_UPLOAD_DIR = original;
    vi.restoreAllMocks();
  });

  it('uses one configured absolute directory independently of process cwd', () => {
    process.env.FLOOR_PLAN_UPLOAD_DIR = path.resolve('test-floor-assets');
    expect(getFloorPlanUploadDirectory()).toBe(path.resolve('test-floor-assets'));
  });

  it('resolves only safe asset filenames below the configured root', () => {
    process.env.FLOOR_PLAN_UPLOAD_DIR = path.resolve('test-floor-assets');
    expect(resolveFloorPlanAssetPath('unit-2-floor-2.pdf')).toBe(
      path.join(path.resolve('test-floor-assets'), 'unit-2-floor-2.pdf'),
    );
    expect(resolveFloorPlanAssetPath('../outside.pdf')).toBeNull();
  });
});
