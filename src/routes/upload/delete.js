import { initR2 } from '../../services/r2.js';
import { HeadObjectCommand } from '@aws-sdk/client-s3';

const fileExists = async (r2, key) =>
  r2.s3.send(new HeadObjectCommand({ Bucket: r2.bucket, Key: key })).then(() => true).catch(() => false);

export async function deleteFile(c) {
  const { key } = await c.req.json();
  if (!key) return c.json({ status: 'fail', message: 'Missing field: key' }, 400);

  const r2 = initR2(c.env);
  if (!(await fileExists(r2, key))) {
    return c.json({ status: 'fail', message: 'File not found', data: { key } }, 404);
  }

  await r2.deleteFile(key);
  return c.json({ status: 'success', message: 'File deleted', data: { key } });
}

export async function deleteFiles(c) {
  const { keys } = await c.req.json();
  if (!Array.isArray(keys) || keys.length === 0) {
    return c.json({ status: 'fail', message: 'Invalid field: keys[] required' }, 400);
  }

  const r2 = initR2(c.env);
  const results = await Promise.all(
    keys.map(async key => {
      if (!(await fileExists(r2, key))) return { key, status: 'not_found', message: 'File missing' };
      try {
        await r2.deleteFile(key);
        return { key, status: 'deleted', message: 'Deleted' };
      } catch (err) {
        return { key, status: 'error', message: 'Failed', error: err.message };
      }
    })
  );

  return c.json({ status: 'success', message: 'Batch delete complete', data: results }, 207);
}

export async function getPublicUrl(c) {
  const key = c.req.param('key');
  const r2 = initR2(c.env);
  return c.json({ status: 'success', message: 'URL generated', data: { key, url: r2.generatePublicUrl(key) } });
}

export async function getPublicUrls(c) {
  const { keys } = await c.req.json();
  if (!Array.isArray(keys) || keys.length === 0) {
    return c.json({ status: 'fail', message: 'Invalid field: keys[] required' }, 400);
  }

  const r2 = initR2(c.env);
  const urls = keys.map(key => ({ key, url: r2.generatePublicUrl(key) }));
  return c.json({ status: 'success', message: 'URLs generated', data: urls });
}
