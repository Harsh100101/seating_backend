import { MongoClient, ObjectId } from 'mongodb';
import { PDFDocument } from 'pdf-lib';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoGridFsFloorPlanAssetStore } from '../src/services/floor-plan-asset-store.js';
import { verifyDisposableTestDatabase } from '../src/utils/test-database-guard.js';

const testUrl = process.env.TEST_DATABASE_URL;
const enabled = process.env.RUN_GRIDFS_INTEGRATION === '1' && Boolean(testUrl);
const suite = enabled ? describe : describe.skip;
const bucketName = `floorPlanAssetsTest${process.pid}`;
let client: MongoClient;
let databaseName = '';
const stores: MongoGridFsFloorPlanAssetStore[] = [];

suite('GridFS floor-plan persistence (isolated MongoDB replica set)', () => {
  beforeAll(async () => {
    const verified = await verifyDisposableTestDatabase(testUrl);
    databaseName = verified.databaseName;
    client = new MongoClient(testUrl!);
    await client.connect();
  });

  afterAll(async () => {
    await Promise.all(stores.map((store) => store.close()));
    if (client) {
      await client.db(databaseName).collection(`${bucketName}.files`).drop().catch(() => undefined);
      await client.db(databaseName).collection(`${bucketName}.chunks`).drop().catch(() => undefined);
      await client.close();
    }
  });

  it('uploads PDF bytes to files/chunks and returns the same checksum after a new store connection', async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage([640, 480]);
    const bytes = Buffer.from(await pdf.save());
    const expected = createHash('sha256').update(bytes).digest('hex');
    const metadata = {
      floorId: 'gridfs-test-floor',
      buildingId: 'gridfs-test-building',
      unitId: 'gridfs-test-unit',
      originalFilename: 'authoritative-test.pdf',
      mimeType: 'application/pdf',
    };

    const first = new MongoGridFsFloorPlanAssetStore(testUrl, bucketName);
    stores.push(first);
    const stored = await first.upload(Readable.from([bytes]), metadata.originalFilename, metadata);
    expect(stored.sha256).toBe(expected);
    expect(stored.length).toBe(bytes.length);

    const db = client.db(databaseName);
    const file = await db.collection(`${bucketName}.files`).findOne({ _id: new ObjectId(stored.id) });
    expect(file?.filename).toBe(metadata.originalFilename);
    expect(file?.metadata).toMatchObject({ ...metadata, sha256: expected, length: bytes.length, status: 'ready' });
    expect(await db.collection(`${bucketName}.chunks`).countDocuments({ files_id: file?._id })).toBeGreaterThan(0);

    await first.close();
    const afterRestart = new MongoGridFsFloorPlanAssetStore(testUrl, bucketName);
    stores.push(afterRestart);
    const reopened = await afterRestart.open(stored.id);
    expect(reopened).toBeTruthy();
    const downloaded: Buffer[] = [];
    for await (const chunk of reopened!.stream) downloaded.push(Buffer.from(chunk));
    const returned = Buffer.concat(downloaded);
    expect(createHash('sha256').update(returned).digest('hex')).toBe(expected);
    expect(returned).toEqual(bytes);
  });

  it('removes partial GridFS chunks after a failed stream upload', async () => {
    const store = new MongoGridFsFloorPlanAssetStore(testUrl, bucketName);
    stores.push(store);
    const filesBefore = await client.db(databaseName).collection(`${bucketName}.files`).countDocuments();
    const chunksBefore = await client.db(databaseName).collection(`${bucketName}.chunks`).countDocuments();
    const source = new Readable({
      read() {
        this.push(Buffer.alloc(300_000, 7));
        this.destroy(new Error('synthetic upload interruption'));
      },
    });
    await expect(store.upload(source, 'interrupted.pdf', {
      floorId: 'interrupted-floor',
      buildingId: 'interrupted-building',
      unitId: 'interrupted-unit',
      originalFilename: 'interrupted.pdf',
      mimeType: 'application/pdf',
    })).rejects.toThrow('synthetic upload interruption');
    expect(await client.db(databaseName).collection(`${bucketName}.files`).countDocuments()).toBe(filesBefore);
    expect(await client.db(databaseName).collection(`${bucketName}.chunks`).countDocuments()).toBe(chunksBefore);
  });
});
