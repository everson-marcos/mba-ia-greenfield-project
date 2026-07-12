import {
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import storageConfig from '../config/storage.config';

const PRESIGNED_URL_EXPIRATION_SECONDS = 3600;

export interface CompletedPart {
  partNumber: number;
  eTag: string;
}

@Injectable()
export class StorageService {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {
    this.bucket = this.config.bucket;
    this.client = new S3Client({
      endpoint: this.config.endpoint,
      forcePathStyle: true,
      region: 'us-east-1',
      credentials: {
        accessKeyId: this.config.accessKeyId,
        secretAccessKey: this.config.secretAccessKey,
      },
    });
  }

  async createMultipartUpload(key: string): Promise<string> {
    const result = await this.client.send(
      new CreateMultipartUploadCommand({ Bucket: this.bucket, Key: key }),
    );
    if (!result.UploadId) {
      throw new Error('Storage did not return an UploadId');
    }
    return result.UploadId;
  }

  async getUploadPartUrl(
    key: string,
    uploadId: string,
    partNumber: number,
  ): Promise<string> {
    return getSignedUrl(
      this.client,
      new UploadPartCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
      }),
      { expiresIn: PRESIGNED_URL_EXPIRATION_SECONDS },
    );
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: CompletedPart[],
  ): Promise<void> {
    await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: parts.map((part) => ({
            PartNumber: part.partNumber,
            ETag: part.eTag,
          })),
        },
      }),
    );
  }

  async uploadFile(key: string, body: Buffer): Promise<void> {
    const upload = new Upload({
      client: this.client,
      params: { Bucket: this.bucket, Key: key, Body: body },
    });
    await upload.done();
  }

  async getPresignedGetUrl(
    key: string,
    responseContentDisposition?: string,
  ): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentDisposition: responseContentDisposition,
      }),
      { expiresIn: PRESIGNED_URL_EXPIRATION_SECONDS },
    );
  }
}
