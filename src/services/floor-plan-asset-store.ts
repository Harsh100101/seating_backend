import { createHash } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { GridFSBucket, MongoClient, ObjectId } from 'mongodb';

export interface FloorPlanAssetMetadata {
  floorId: string;
  buildingId: string;
  unitId: string;
  originalFilename: string;
  mimeType: string;
  sha256: string;
  length: number;
}

export interface FloorPlanAsset {
  id: string;
  filename: string;
  metadata: Partial<FloorPlanAssetMetadata> & Record<string, unknown>;
  length: number;
  stream: Readable;
}

export interface FloorPlanAssetStore {
  upload(source: Readable, filename: string, metadata: Omit<FloorPlanAssetMetadata, 'sha256' | 'length'>): Promise<FloorPlanAssetMetadata & { id: string }>;
  open(id: string): Promise<FloorPlanAsset | null>;
  delete(id: string): Promise<void>;
  close(): Promise<void>;
}

export class MongoGridFsFloorPlanAssetStore implements FloorPlanAssetStore {
  private client?: MongoClient;
  private bucket?: GridFSBucket;
  private connection?: Promise<void>;

  constructor(
    private readonly connectionString = process.env.DATABASE_URL,
    private readonly bucketName = 'floorPlanAssets',
  ) {}

  private async connect(): Promise<void> {
    if (!this.connection) {
      this.connection = (async () => {
        if (!this.connectionString?.trim()) throw new Error('DATABASE_URL is required for GridFS floor-plan storage.');
        const client = new MongoClient(this.connectionString, { appName: 'shakti-sankul-floor-plan-gridfs' });
        await client.connect();
        this.client = client;
        this.bucket = new GridFSBucket(client.db(), { bucketName: this.bucketName });
      })().catch((error) => {
        this.connection = undefined;
        throw error;
      });
    }
    await this.connection;
  }

  async upload(
    source: Readable,
    filename: string,
    metadata: Omit<FloorPlanAssetMetadata, 'sha256' | 'length'>,
  ): Promise<FloorPlanAssetMetadata & { id: string }> {
    await this.connect();
    const bucket = this.bucket!;
    const db = this.client!.db();
    const hash = createHash('sha256');
    let length = 0;
    const upload = bucket.openUploadStream(filename, { metadata: { ...metadata, status: 'pending' } });
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        hash.update(chunk);
        length += chunk.length;
        callback(null, chunk);
      },
    });

    try {
      await pipeline(source, meter, upload);
      const sha256 = hash.digest('hex');
      await db.collection(`${this.bucketName}.files`).updateOne(
        { _id: upload.id },
        { $set: { 'metadata.sha256': sha256, 'metadata.length': length, 'metadata.status': 'ready' } },
      );
      return { id: upload.id.toHexString(), ...metadata, sha256, length };
    } catch (error) {
      await upload.abort().catch(() => undefined);
      await Promise.allSettled([
        db.collection(`${this.bucketName}.files`).deleteOne({ _id: upload.id }),
        db.collection(`${this.bucketName}.chunks`).deleteMany({ files_id: upload.id }),
      ]);
      throw error;
    }
  }

  async open(id: string): Promise<FloorPlanAsset | null> {
    if (!ObjectId.isValid(id)) return null;
    await this.connect();
    const objectId = new ObjectId(id);
    const file = await this.client!.db().collection(`${this.bucketName}.files`).findOne({ _id: objectId });
    if (!file || file.metadata?.status !== 'ready') return null;
    return {
      id: objectId.toHexString(),
      filename: String(file.filename || ''),
      metadata: file.metadata || {},
      length: Number(file.length || 0),
      stream: this.bucket!.openDownloadStream(objectId),
    };
  }

  async delete(id: string): Promise<void> {
    if (!ObjectId.isValid(id)) return;
    await this.connect();
    const objectId = new ObjectId(id);
    await Promise.all([
      this.client!.db().collection(`${this.bucketName}.files`).deleteOne({ _id: objectId }),
      this.client!.db().collection(`${this.bucketName}.chunks`).deleteMany({ files_id: objectId }),
    ]);
  }

  async close(): Promise<void> {
    await this.client?.close();
    this.client = undefined;
    this.bucket = undefined;
    this.connection = undefined;
  }
}

/** In-memory adapter for Fastify tests. Runtime code uses MongoDB GridFS. */
export class MemoryFloorPlanAssetStore implements FloorPlanAssetStore {
  private readonly files = new Map<string, { filename: string; metadata: FloorPlanAssetMetadata; bytes: Buffer }>();

  async upload(
    source: Readable,
    filename: string,
    metadata: Omit<FloorPlanAssetMetadata, 'sha256' | 'length'>,
  ): Promise<FloorPlanAssetMetadata & { id: string }> {
    const chunks: Buffer[] = [];
    for await (const chunk of source) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const id = new ObjectId().toHexString();
    const stored = { ...metadata, sha256, length: bytes.length };
    this.files.set(id, { filename, metadata: stored, bytes });
    return { id, ...stored };
  }

  async open(id: string): Promise<FloorPlanAsset | null> {
    const file = this.files.get(id);
    return file ? {
      id,
      filename: file.filename,
      metadata: { ...file.metadata },
      length: file.bytes.length,
      stream: Readable.from([file.bytes]),
    } : null;
  }

  async delete(id: string): Promise<void> { this.files.delete(id); }
  async close(): Promise<void> {}
}

export const getGridFsFloorPlanId = (imageUrl: string | null | undefined): { id: string; extension: string } | null => {
  const match = imageUrl?.match(/^\/uploads\/floors\/([a-f\d]{24})\.(pdf|png|jpe?g|webp|svg)$/i);
  return match ? { id: match[1], extension: match[2].toLowerCase() } : null;
};
