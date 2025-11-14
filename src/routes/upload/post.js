import { initR2 } from '../../services/r2.js';

/**
 * Generate upload URL(s) for any file type.
 * Accepts JSON body shapes:
 * - { files: [{ name?, ext?, contentType?, prefix? }, ...] }
 * - { file: { name?, ext?, contentType?, prefix? } }
 * - { count: N, ext?: 'jpg', contentType?: 'image/jpeg', prefix?: 'uploads' }
 *
 * For `name` the code will try to derive extension from the filename if ext is not provided.
 * Any contentType is allowed and passed through to the response so the frontend may use it when uploading.
 */
export async function generateUploadUrls(ctx) {
  try {
    const r2 = await initR2();
    const body = await ctx.req.json().catch(() => ({}));

    const items = [];

    const normalizeExtFromName = (name) => {
      if (!name || typeof name !== 'string') return undefined;
      const idx = name.lastIndexOf('.');
      if (idx === -1) return undefined;
      return name.slice(idx + 1).toLowerCase();
    };

    const makeEntry = (opts = {}) => {
      const name = typeof opts.name === 'string' && opts.name.trim() ? opts.name.trim() : undefined;
      const ext = opts.ext && typeof opts.ext === 'string'
        ? opts.ext.replace(/^\./, '').toLowerCase()
        : normalizeExtFromName(name) || 'bin';
      const prefix = typeof opts.prefix === 'string' && opts.prefix.trim() ? opts.prefix.trim() : 'uploads';
      const contentType = typeof opts.contentType === 'string' && opts.contentType.trim()
        ? opts.contentType.trim()
        : 'application/octet-stream';

      const key = r2.generateFilename(ext, prefix);
      return {
        key,
        publicUrl: r2.generatePublicUrl(key),
        uploadUrl: r2.generateUploadUrl(key),
        contentType,
        suggestedName: name || key.split('/').pop(),
        ext,
      };
    };

    if (Array.isArray(body.files) && body.files.length > 0) {
      for (const f of body.files) {
        items.push(makeEntry(f || {}));
      }
    } else if (body.file && typeof body.file === 'object') {
      items.push(makeEntry(body.file));
    } else {
      const countRaw = Number(body.count);
      const count = Number.isInteger(countRaw) && countRaw > 0 ? countRaw : 1;
      const ext = typeof body.ext === 'string' && body.ext.trim() ? body.ext.replace(/^\./, '').toLowerCase() : undefined;
      const prefix = typeof body.prefix === 'string' && body.prefix.trim() ? body.prefix.trim() : 'uploads';
      const contentType = typeof body.contentType === 'string' && body.contentType.trim()
        ? body.contentType.trim()
        : undefined;

      for (let i = 0; i < count; i++) {
        items.push(makeEntry({ ext, prefix, contentType }));
      }
    }

    return ctx.json({ success: true, files: items }, 200);
  } catch (err) {
    return ctx.json({ success: false, error: (err && err.message) || 'Failed to generate upload URLs' }, 500);
  }
}

export default generateUploadUrls;
