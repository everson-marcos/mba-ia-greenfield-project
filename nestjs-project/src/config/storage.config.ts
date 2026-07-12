import { registerAs } from '@nestjs/config';

export default registerAs('storage', () => ({
  endpoint: process.env.STORAGE_ENDPOINT || 'http://minio:9000',
  accessKeyId: process.env.STORAGE_ACCESS_KEY || 'minioadmin',
  secretAccessKey: process.env.STORAGE_SECRET_KEY || 'minioadmin',
  bucket: process.env.STORAGE_BUCKET || 'streamtube',
}));
