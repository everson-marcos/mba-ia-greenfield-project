import {
  CreateBucketCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import storageConfig from '../config/storage.config';
import { StorageService } from './storage.service';

describe('StorageService (integration)', () => {
  let service: StorageService;
  let rawClient: S3Client;
  const bucket = process.env.STORAGE_BUCKET ?? 'streamtube';

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
      ],
      providers: [StorageService],
    }).compile();

    service = moduleRef.get(StorageService);

    rawClient = new S3Client({
      endpoint: process.env.STORAGE_ENDPOINT ?? 'http://minio:9000',
      forcePathStyle: true,
      region: 'us-east-1',
      credentials: {
        accessKeyId: process.env.STORAGE_ACCESS_KEY ?? 'minioadmin',
        secretAccessKey: process.env.STORAGE_SECRET_KEY ?? 'minioadmin',
      },
    });

    try {
      await rawClient.send(new HeadBucketCommand({ Bucket: bucket }));
    } catch {
      await rawClient.send(new CreateBucketCommand({ Bucket: bucket }));
    }
  });

  it('should upload an object and retrieve it via a presigned GET url that supports Range requests', async () => {
    const key = `test/${crypto.randomUUID()}.txt`;
    const content = 'hello streamtube';

    await rawClient.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: Buffer.from(content),
      }),
    );

    const url = await service.getPresignedGetUrl(key);
    expect(url).toContain(key);

    const rangeResponse = await fetch(url, {
      headers: { Range: 'bytes=0-4' },
    });
    expect(rangeResponse.status).toBe(206);
    expect(rangeResponse.headers.get('content-range')).toBeTruthy();

    await rawClient.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  });

  it('should orchestrate a full multipart upload (create, sign part url, complete)', async () => {
    const key = `test/${crypto.randomUUID()}.bin`;
    const partBody = Buffer.alloc(5 * 1024 * 1024, 'a'); // 5MB — S3 minimum part size

    const uploadId = await service.createMultipartUpload(key);
    expect(uploadId).toBeTruthy();

    const partUrl = await service.getUploadPartUrl(key, uploadId, 1);
    const putResponse = await fetch(partUrl, {
      method: 'PUT',
      body: partBody,
    });
    expect(putResponse.status).toBe(200);
    const eTag = putResponse.headers.get('etag');
    expect(eTag).toBeTruthy();

    await service.completeMultipartUpload(key, uploadId, [
      { partNumber: 1, eTag: eTag as string },
    ]);

    await rawClient.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  });
});
