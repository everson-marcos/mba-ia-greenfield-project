import {
  CreateBucketCommand,
  HeadBucketCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { cleanAllTables } from '../src/test/create-test-data-source';

const bucket = process.env.STORAGE_BUCKET ?? 'streamtube';

interface AuthTokensBody {
  access_token: string;
  refresh_token: string;
}

interface CreateVideoBody {
  id: string;
  uploadId: string;
  partSize: number;
}

interface ApiErrorBody {
  error: string;
}

interface AuthServiceInternals {
  mailService: {
    sendConfirmationEmail: (
      email: string,
      name: string,
      token: string,
    ) => Promise<void>;
  };
}

describe('videos', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let throttlerStorage: ThrottlerStorageService;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);

    const s3Client = new S3Client({
      endpoint: process.env.STORAGE_ENDPOINT ?? 'http://minio:9000',
      forcePathStyle: true,
      region: 'us-east-1',
      credentials: {
        accessKeyId: process.env.STORAGE_ACCESS_KEY ?? 'minioadmin',
        secretAccessKey: process.env.STORAGE_SECRET_KEY ?? 'minioadmin',
      },
    });
    try {
      await s3Client.send(new HeadBucketCommand({ Bucket: bucket }));
    } catch {
      await s3Client.send(new CreateBucketCommand({ Bucket: bucket }));
    }
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
  });

  async function captureConfirmationToken(
    email: string,
    password = 'password123',
  ): Promise<string> {
    const authService = app.get(AuthService);
    const { mailService: mailServiceInstance } =
      authService as unknown as AuthServiceInternals;
    let capturedToken = '';
    jest
      .spyOn(mailServiceInstance, 'sendConfirmationEmail')
      .mockImplementationOnce((_e: string, _n: string, t: string) => {
        capturedToken = t;
        return Promise.resolve();
      });
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password });
    return capturedToken;
  }

  async function registerConfirmAndLogin(
    email: string,
    password = 'password123',
  ): Promise<AuthTokensBody> {
    const token = await captureConfirmationToken(email, password);
    await request(app.getHttpServer())
      .get('/auth/confirm-email')
      .query({ token });
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password });
    const body = res.body as AuthTokensBody;
    return {
      access_token: body.access_token,
      refresh_token: body.refresh_token,
    };
  }

  async function createVideo(
    accessToken: string,
    overrides: { title?: string; fileSize?: number } = {},
  ): Promise<CreateVideoBody> {
    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        title: overrides.title ?? 'Vídeo de teste',
        fileSize: overrides.fileSize ?? 1048576,
      });
    return res.body as CreateVideoBody;
  }

  async function uploadOnePart(
    accessToken: string,
    videoId: string,
  ): Promise<string> {
    const res = await request(app.getHttpServer())
      .get(`/videos/${videoId}/upload-part-url`)
      .query({ partNumber: 1 })
      .set('Authorization', `Bearer ${accessToken}`);
    const { url } = res.body as { url: string };

    const partBody = Buffer.alloc(5 * 1024 * 1024, 'a');
    const putResponse = await fetch(url, { method: 'PUT', body: partBody });
    return putResponse.headers.get('etag') as string;
  }

  describe('POST /videos', () => {
    it('cria-video-com-payload-valido', async () => {
      const { access_token } = await registerConfirmAndLogin(
        'video-owner@example.com',
      );

      const res = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${access_token}`)
        .send({ title: 'Meu vídeo', fileSize: 1048576 })
        .expect(201);

      const body = res.body as CreateVideoBody;
      expect(body.id).toBeDefined();
      expect(body.uploadId).toBeDefined();
      expect(body.partSize).toBeDefined();

      const rows = await dataSource.query<{ status: string }[]>(
        'SELECT status FROM "videos" WHERE id = $1',
        [body.id],
      );
      expect(rows[0].status).toBe('rascunho');
    });

    it('rejeita-titulo-ausente', async () => {
      const { access_token } = await registerConfirmAndLogin(
        'video-no-title@example.com',
      );

      await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${access_token}`)
        .send({ fileSize: 1048576 })
        .expect(400);
    });

    it('rejeita-arquivo-maior-que-10gb', async () => {
      const { access_token } = await registerConfirmAndLogin(
        'video-huge@example.com',
      );

      const res = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${access_token}`)
        .send({ title: 'Vídeo enorme', fileSize: 10737418241 })
        .expect(400);

      const body = res.body as ApiErrorBody;
      expect(body.error).toBe('FILE_TOO_LARGE');
    });
  });

  describe('GET /videos/:id/upload-part-url', () => {
    it('retorna-url-para-dono', async () => {
      const { access_token } = await registerConfirmAndLogin(
        'part-url-owner@example.com',
      );
      const video = await createVideo(access_token);

      const res = await request(app.getHttpServer())
        .get(`/videos/${video.id}/upload-part-url`)
        .query({ partNumber: 1 })
        .set('Authorization', `Bearer ${access_token}`)
        .expect(200);

      expect((res.body as { url: string }).url).toBeTruthy();
    });

    it('rejeita-nao-dono', async () => {
      const owner = await registerConfirmAndLogin(
        'part-url-owner2@example.com',
      );
      const other = await registerConfirmAndLogin(
        'part-url-intruder@example.com',
      );
      const video = await createVideo(owner.access_token);

      const res = await request(app.getHttpServer())
        .get(`/videos/${video.id}/upload-part-url`)
        .query({ partNumber: 1 })
        .set('Authorization', `Bearer ${other.access_token}`)
        .expect(403);

      expect((res.body as ApiErrorBody).error).toBe('VIDEO_NOT_OWNED');
    });

    it('retorna-404-para-video-inexistente', async () => {
      const { access_token } = await registerConfirmAndLogin(
        'part-url-missing@example.com',
      );

      const res = await request(app.getHttpServer())
        .get('/videos/00000000-0000-0000-0000-000000000000/upload-part-url')
        .query({ partNumber: 1 })
        .set('Authorization', `Bearer ${access_token}`)
        .expect(404);

      expect((res.body as ApiErrorBody).error).toBe('VIDEO_NOT_FOUND');
    });

    it('rejeita-upload-ja-completado', async () => {
      const { access_token } = await registerConfirmAndLogin(
        'part-url-completed@example.com',
      );
      const video = await createVideo(access_token);
      await dataSource.query('UPDATE "videos" SET status = $1 WHERE id = $2', [
        'processando',
        video.id,
      ]);

      const res = await request(app.getHttpServer())
        .get(`/videos/${video.id}/upload-part-url`)
        .query({ partNumber: 1 })
        .set('Authorization', `Bearer ${access_token}`)
        .expect(409);

      expect((res.body as ApiErrorBody).error).toBe('UPLOAD_ALREADY_COMPLETED');
    });
  });

  describe('POST /videos/:id/complete-upload', () => {
    it('completa-upload-e-enfileira-job', async () => {
      const { access_token } = await registerConfirmAndLogin(
        'complete-owner@example.com',
      );
      const video = await createVideo(access_token, {
        fileSize: 5 * 1024 * 1024,
      });
      const eTag = await uploadOnePart(access_token, video.id);

      const res = await request(app.getHttpServer())
        .post(`/videos/${video.id}/complete-upload`)
        .set('Authorization', `Bearer ${access_token}`)
        .send({ parts: [{ partNumber: 1, eTag }] })
        .expect(200);

      expect((res.body as { id: string; status: string }).status).toBe(
        'processando',
      );

      const rows = await dataSource.query<{ status: string }[]>(
        'SELECT status FROM "videos" WHERE id = $1',
        [video.id],
      );
      expect(rows[0].status).toBe('processando');
    });

    it('rejeita-etag-invalido', async () => {
      const { access_token } = await registerConfirmAndLogin(
        'complete-bad-etag@example.com',
      );
      const video = await createVideo(access_token, {
        fileSize: 5 * 1024 * 1024,
      });

      const res = await request(app.getHttpServer())
        .post(`/videos/${video.id}/complete-upload`)
        .set('Authorization', `Bearer ${access_token}`)
        .send({ parts: [{ partNumber: 1, eTag: '"forged-etag"' }] })
        .expect(400);

      expect((res.body as ApiErrorBody).error).toBe('INVALID_UPLOAD_PART');
    });

    it('rejeita-nao-dono', async () => {
      const owner = await registerConfirmAndLogin(
        'complete-owner2@example.com',
      );
      const other = await registerConfirmAndLogin(
        'complete-intruder@example.com',
      );
      const video = await createVideo(owner.access_token, {
        fileSize: 5 * 1024 * 1024,
      });
      const eTag = await uploadOnePart(owner.access_token, video.id);

      const res = await request(app.getHttpServer())
        .post(`/videos/${video.id}/complete-upload`)
        .set('Authorization', `Bearer ${other.access_token}`)
        .send({ parts: [{ partNumber: 1, eTag }] })
        .expect(403);

      expect((res.body as ApiErrorBody).error).toBe('VIDEO_NOT_OWNED');
    });

    it('rejeita-upload-ja-completado', async () => {
      const { access_token } = await registerConfirmAndLogin(
        'complete-twice@example.com',
      );
      const video = await createVideo(access_token, {
        fileSize: 5 * 1024 * 1024,
      });
      const eTag = await uploadOnePart(access_token, video.id);
      await request(app.getHttpServer())
        .post(`/videos/${video.id}/complete-upload`)
        .set('Authorization', `Bearer ${access_token}`)
        .send({ parts: [{ partNumber: 1, eTag }] })
        .expect(200);

      const res = await request(app.getHttpServer())
        .post(`/videos/${video.id}/complete-upload`)
        .set('Authorization', `Bearer ${access_token}`)
        .send({ parts: [{ partNumber: 1, eTag }] })
        .expect(409);

      expect((res.body as ApiErrorBody).error).toBe('UPLOAD_ALREADY_COMPLETED');
    });
  });

  describe('GET /videos/:id', () => {
    it('retorna-status-para-dono', async () => {
      const { access_token } = await registerConfirmAndLogin(
        'status-owner@example.com',
      );
      const video = await createVideo(access_token, { title: 'Meu vídeo' });

      const res = await request(app.getHttpServer())
        .get(`/videos/${video.id}`)
        .set('Authorization', `Bearer ${access_token}`)
        .expect(200);

      const body = res.body as {
        id: string;
        title: string;
        status: string;
      };
      expect(body.id).toBe(video.id);
      expect(body.title).toBe('Meu vídeo');
      expect(body.status).toBe('rascunho');
    });

    it('rejeita-nao-dono', async () => {
      const owner = await registerConfirmAndLogin('status-owner2@example.com');
      const other = await registerConfirmAndLogin(
        'status-intruder@example.com',
      );
      const video = await createVideo(owner.access_token);

      const res = await request(app.getHttpServer())
        .get(`/videos/${video.id}`)
        .set('Authorization', `Bearer ${other.access_token}`)
        .expect(403);

      expect((res.body as ApiErrorBody).error).toBe('VIDEO_NOT_OWNED');
    });

    it('retorna-404-para-video-inexistente', async () => {
      const { access_token } = await registerConfirmAndLogin(
        'status-missing@example.com',
      );

      const res = await request(app.getHttpServer())
        .get('/videos/00000000-0000-0000-0000-000000000000')
        .set('Authorization', `Bearer ${access_token}`)
        .expect(404);

      expect((res.body as ApiErrorBody).error).toBe('VIDEO_NOT_FOUND');
    });
  });

  async function createReadyVideo(accessToken: string): Promise<string> {
    const video = await createVideo(accessToken, {
      fileSize: 5 * 1024 * 1024,
    });
    const eTag = await uploadOnePart(accessToken, video.id);
    await request(app.getHttpServer())
      .post(`/videos/${video.id}/complete-upload`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ parts: [{ partNumber: 1, eTag }] })
      .expect(200);
    await dataSource.query('UPDATE "videos" SET status = $1 WHERE id = $2', [
      'pronto',
      video.id,
    ]);
    return video.id;
  }

  describe('GET /videos/:id/stream', () => {
    it('retorna-url-publica-para-video-pronto', async () => {
      const { access_token } = await registerConfirmAndLogin(
        'stream-owner@example.com',
      );
      const videoId = await createReadyVideo(access_token);

      const res = await request(app.getHttpServer())
        .get(`/videos/${videoId}/stream`)
        .expect(200);

      expect((res.body as { url: string }).url).toBeTruthy();
    });

    it('url-responde-range-com-206', async () => {
      const { access_token } = await registerConfirmAndLogin(
        'stream-range@example.com',
      );
      const videoId = await createReadyVideo(access_token);

      const res = await request(app.getHttpServer())
        .get(`/videos/${videoId}/stream`)
        .expect(200);
      const { url } = res.body as { url: string };

      const rangeResponse = await fetch(url, {
        headers: { Range: 'bytes=0-99' },
      });
      expect(rangeResponse.status).toBe(206);
      expect(rangeResponse.headers.get('content-range')).toBeTruthy();
    });

    it('rejeita-video-nao-pronto', async () => {
      const owner = await registerConfirmAndLogin('stream-owner2@example.com');
      const video = await createVideo(owner.access_token);

      const res = await request(app.getHttpServer())
        .get(`/videos/${video.id}/stream`)
        .expect(409);

      expect((res.body as ApiErrorBody).error).toBe('VIDEO_NOT_READY');
    });

    it('retorna-404-para-video-inexistente', async () => {
      const res = await request(app.getHttpServer())
        .get('/videos/00000000-0000-0000-0000-000000000000/stream')
        .expect(404);

      expect((res.body as ApiErrorBody).error).toBe('VIDEO_NOT_FOUND');
    });
  });

  describe('GET /videos/:id/download', () => {
    it('retorna-url-de-download-publica', async () => {
      const { access_token } = await registerConfirmAndLogin(
        'download-owner@example.com',
      );
      const videoId = await createReadyVideo(access_token);

      const res = await request(app.getHttpServer())
        .get(`/videos/${videoId}/download`)
        .expect(200);

      const { url } = res.body as { url: string };
      expect(url).toBeTruthy();
      expect(
        new URL(url).searchParams.get('response-content-disposition'),
      ).toBe('attachment');
    });

    it('rejeita-video-nao-pronto', async () => {
      const owner = await registerConfirmAndLogin(
        'download-owner2@example.com',
      );
      const video = await createVideo(owner.access_token);

      const res = await request(app.getHttpServer())
        .get(`/videos/${video.id}/download`)
        .expect(409);

      expect((res.body as ApiErrorBody).error).toBe('VIDEO_NOT_READY');
    });
  });
});
