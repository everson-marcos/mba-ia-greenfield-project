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
});
