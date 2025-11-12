import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import crypto from 'node:crypto';

let s3, setupError, setupPromise;
let R2_BUCKET, R2_ENDPOINT;

const ensureReady = async () => {
  if (setupError) throw setupError;
  if (s3) return;

  if (!setupPromise) {
    setupPromise = (async () => {
      const {
        R2_BUCKET: bucket = 'tubnixcloud',
        R2_ACCESS_KEY = '',
        R2_SECRET_KEY,
        R2_ENDPOINT: endpoint,
      } = process.env;

      if (!R2_SECRET_KEY || !endpoint) {
        setupError = new Error('Missing R2_SECRET_KEY or R2_ENDPOINT.');
        return;
      }

      R2_BUCKET = bucket;
      R2_ENDPOINT = endpoint;

      s3 = new S3Client({
        region: 'auto',
        endpoint,
        credentials: {
          accessKeyId: R2_ACCESS_KEY,
          secretAccessKey: R2_SECRET_KEY,
        },
      });
    })();
  }

  await setupPromise;
  if (setupError) throw setupError;
};

export async function initR2() {
  await ensureReady();

  const generateFilename = (ext = 'jpg', prefix = 'uploads') =>
    `${prefix}/${crypto.randomUUID()}.${ext}`;

  const generatePublicUrl = (key) => `${R2_ENDPOINT}/${R2_BUCKET}/${key}`;

  const generateUploadUrl = (key) => `${R2_ENDPOINT}/${R2_BUCKET}/${key}`;

  const uploadFile = async (key, buffer, contentType = 'image/jpeg') => {
    await s3.send(new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: key,
      Body: buffer,
      ContentType: contentType,
    }));
  };

  const deleteFile = async (key) => {
    if (!key) throw new Error('File key required.');
    await s3.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: key }));
    return true;
  };

  return {
    generateFilename,
    generatePublicUrl,
    generateUploadUrl,
    uploadFile,
    deleteFile,
  };
}
