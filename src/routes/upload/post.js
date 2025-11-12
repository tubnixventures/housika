import { initR2 } from '../../services/r2.js';

export async function generateUploadUrls(c) {
  const files = await c.req.json();
  if (!Array.isArray(files) || files.length === 0) {
    return c.json({ error: 'Expected a non-empty array of file descriptors.' }, 400);
  }

  try {
    const r2 = await initR2(c.env);
    const results = files.map(({ extension = 'jpg', prefix = 'uploads', contentType = 'image/jpeg' }) => {
      const key = r2.generateFilename(extension, prefix);
      return {
        key,
        uploadUrl: r2.generateUploadUrl(key, contentType),
        publicUrl: r2.generatePublicUrl(key),
      };
    });

    return c.json({ status: 'success', message: 'Upload URLs generated', files: results });
  } catch (err) {
    console.error('❌ R2 upload URL generation failed:', err);
    return c.json({ error: 'Upload URL generation failed.' }, 500);
  }
}
