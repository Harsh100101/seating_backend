import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { MongoClient } from 'mongodb';
import { PrismaClient } from '@prisma/client';
import { loadApplicationEnvironment, requireDatabaseUrl } from '../src/config/environment.js';
import { MongoGridFsFloorPlanAssetStore, getGridFsFloorPlanId } from '../src/services/floor-plan-asset-store.js';
import { getFloorPlanAssetDirectories, resolveFloorPlanAssetPaths } from '../src/utils/floor-plan-storage.js';

const MAX_BYTES = 25 * 1024 * 1024;
const args = process.argv.slice(2);
const apply = args.includes('--apply');
const approvalId = args.find((arg) => arg.startsWith('--approval-id='))?.slice('--approval-id='.length).trim();

if (apply && (process.env.GRIDFS_PRODUCTION_MIGRATION_APPROVED !== 'YES' || !approvalId)) {
  throw new Error('Writes require owner approval: set GRIDFS_PRODUCTION_MIGRATION_APPROVED=YES and pass --approval-id=<approved change reference>.');
}
if (apply && args.includes('--dry-run')) throw new Error('Choose either --dry-run or --apply.');

loadApplicationEnvironment();
const databaseUrl = requireDatabaseUrl();
const prisma = new PrismaClient();
const mongo = new MongoClient(databaseUrl, { appName: 'shakti-sankul-gridfs-migration' });
const store = new MongoGridFsFloorPlanAssetStore(databaseUrl);

type Candidate = {
  floor: any;
  filename: string;
  filePath: string;
  extension: string;
  mimeType: string;
  sha256: string;
  length: number;
};

async function checksum(filePath: string) {
  const hash = createHash('sha256');
  let length = 0;
  for await (const chunk of fs.createReadStream(filePath)) {
    const bytes = Buffer.from(chunk);
    length += bytes.length;
    if (length > MAX_BYTES) throw new Error('file exceeds the supported 25 MB limit');
    hash.update(bytes);
  }
  return { sha256: hash.digest('hex'), length };
}

async function sniff(filePath: string, extension: string): Promise<string | null> {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const sample = Buffer.alloc(1024);
    const { bytesRead } = await handle.read(sample, 0, sample.length, 0);
    const bytes = sample.subarray(0, bytesRead);
    const ext = extension.toLowerCase();
    if (ext === 'pdf' && bytes.subarray(0, 5).toString('ascii') === '%PDF-') return 'application/pdf';
    if (ext === 'png' && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
    if (['jpg', 'jpeg'].includes(ext) && bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) return 'image/jpeg';
    if (ext === 'webp' && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
    if (ext === 'svg') {
      const text = (await fs.promises.readFile(filePath)).toString('utf8');
      if (/<svg[\s>]/i.test(text) && !/<\/?script\b|\bon\w+\s*=|<\/?foreignObject\b|<\/?iframe\b|<\/?object\b|<\/?embed\b|\b(?:href|xlink:href)\s*=\s*["']\s*(?:https?:|data:|javascript:)/i.test(text)) return 'image/svg+xml';
    }
    return null;
  } finally {
    await handle.close();
  }
}

async function streamHash(stream: NodeJS.ReadableStream): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of stream as AsyncIterable<Buffer>) hash.update(chunk);
  return hash.digest('hex');
}

async function main() {
  await mongo.connect();
  const db = mongo.db();
  const floors = await prisma.floor.findMany({
    where: { imageUrl: { startsWith: '/uploads/floors/' } },
    include: { building: { include: { plant: true } } },
    orderBy: { id: 'asc' },
  });
  const results: Array<{ floorId: string; result: string }> = [];

  for (const floor of floors) {
    const reference = String(floor.imageUrl || '');
    const gridFsReference = getGridFsFloorPlanId(reference);
    if (gridFsReference) {
      const asset = await store.open(gridFsReference.id);
      if (!asset) {
        results.push({ floorId: floor.id, result: 'missing-gridfs-object' });
        continue;
      }
      const observedHash = await streamHash(asset.stream);
      const matches = asset.metadata.floorId === floor.id
        && asset.metadata.buildingId === floor.buildingId
        && asset.metadata.sha256 === observedHash;
      results.push({ floorId: floor.id, result: matches ? 'already-migrated-verified' : 'gridfs-metadata-or-checksum-mismatch' });
      continue;
    }

    const rawFilename = reference.slice('/uploads/floors/'.length).split('#')[0];
    const filename = pathSafeFilename(rawFilename);
    if (!filename) {
      results.push({ floorId: floor.id, result: 'unsafe-or-invalid-reference' });
      continue;
    }
    const extension = filename.split('.').pop()?.toLowerCase() || '';
    const candidate = await firstValidCandidate(filename, extension);
    if (!candidate) {
      results.push({ floorId: floor.id, result: 'local-file-missing-or-signature-invalid' });
      continue;
    }
    const { filePath, mimeType } = candidate;
    const measured = await checksum(filePath);
    const existing = await db.collection('floorPlanAssets.files').findOne({
      'metadata.floorId': floor.id,
      'metadata.sha256': measured.sha256,
      'metadata.status': 'ready',
    });
    if (existing) {
      const referenceUrl = `/uploads/floors/${String(existing._id)}.${extension}`;
      const file = await store.open(String(existing._id));
      const verified = file && await streamHash(file.stream) === measured.sha256;
      if (!verified) {
        results.push({ floorId: floor.id, result: 'existing-gridfs-checksum-mismatch' });
        continue;
      }
      if (apply) await prisma.floor.update({ where: { id: floor.id }, data: { imageUrl: referenceUrl } });
      results.push({ floorId: floor.id, result: apply ? 'metadata-updated-to-existing-verified-file' : 'matching-gridfs-file-found-dry-run' });
      continue;
    }

    if (!apply) {
      results.push({ floorId: floor.id, result: 'verified-local-file-ready-for-approved-migration' });
      continue;
    }

    const unitId = floor.building.unitId || floor.building.plant?.unitId;
    if (!unitId) {
      results.push({ floorId: floor.id, result: 'missing-unit-association' });
      continue;
    }
    let stored: Awaited<ReturnType<MongoGridFsFloorPlanAssetStore['upload']>> | undefined;
    try {
      stored = await store.upload(fs.createReadStream(filePath), filename, {
        floorId: floor.id,
        buildingId: floor.buildingId,
        unitId,
        originalFilename: filename,
        mimeType,
      });
      const uploadedFile = await store.open(stored.id);
      const downloadedHash = uploadedFile && await streamHash(uploadedFile.stream);
      if (downloadedHash !== measured.sha256 || stored.sha256 !== measured.sha256) {
        throw new Error('GridFS retrieval checksum does not match the source file');
      }
      await prisma.floor.update({
        where: { id: floor.id },
        data: { imageUrl: `/uploads/floors/${stored.id}.${extension}` },
      });
      results.push({ floorId: floor.id, result: 'migrated-and-verified' });
    } catch (error) {
      if (stored) await store.delete(stored.id).catch(() => undefined);
      results.push({ floorId: floor.id, result: `failed:${error instanceof Error ? error.name : 'unknown-error'}` });
    }
  }

  const counts = results.reduce<Record<string, number>>((summary, row) => {
    summary[row.result] = (summary[row.result] || 0) + 1;
    return summary;
  }, {});
  console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', approvalId: apply ? approvalId : undefined, scannedFloorReferences: floors.length, counts, results }, null, 2));
}

function pathSafeFilename(filename: string): string | null {
  if (!filename || filename !== path.basename(filename) || filename !== path.win32.basename(filename) || filename.includes('..') || pathSafeBase(filename) !== filename) return null;
  return filename;
}

function pathSafeBase(filename: string): string { return filename.split(/[\\/]/).pop() || ''; }

async function firstValidCandidate(filename: string, extension: string): Promise<{ filePath: string; mimeType: string } | null> {
  for (const candidate of resolveFloorPlanAssetPaths(filename)) {
    if (!fs.existsSync(candidate)) continue;
    if ((await fs.promises.stat(candidate)).size > MAX_BYTES) continue;
    const mimeType = await sniff(candidate, extension);
    if (mimeType) return { filePath: candidate, mimeType };
  }
  return null;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'GridFS migration failed');
  process.exitCode = 1;
}).finally(async () => {
  await store.close();
  await mongo.close();
  await prisma.$disconnect();
});
