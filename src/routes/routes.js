import { Hono } from 'hono';

/**
 * createLazyRouter(importFn)
 * - importFn: () => import('./some/routes.js')
 * - Returns a proxy router object that implements the same "fetch" entry Hono expects.
 * - The module is imported once per worker and cached. First request pays the import cost.
 */
function createLazyRouter(importFn) {
  let loaded = null;
  let loading = null;

  async function ensureLoaded() {
    if (loaded) return loaded;
    if (!loading) {
      loading = importFn()
        .then((m) => {
          // prefer default export, fallback to module itself
          loaded = m?.default || m;
          return loaded;
        })
        .catch((err) => {
          loading = null;
          throw err;
        });
    }
    return loading;
  }

  // Hono accepts a Router-like object with `fetch` method, so expose one.
  return {
    // `fetch` is invoked with (request-like) context in Hono internals
    async fetch(request, env, ctx) {
      const router = await ensureLoaded();
      // If the loaded router is a Hono instance, it exposes `fetch`.
      if (typeof router.fetch === 'function') {
        return router.fetch(request, env, ctx);
      }
      // If the module exported a function that expects a Hono context, call it as middleware:
      if (typeof router === 'function') {
        return router(request, env, ctx);
      }
      // Unknown shape
      throw new Error('Lazy-loaded route has no fetch function');
    },
  };
}

// --- Lazy route factory helpers (change paths to match your project) ---
const lazy = (p) => createLazyRouter(() => import(p));

// --- App ---
const app = new Hono();

// --- Public Routes (lazy loaded) ---
app.route('/contactMessages', lazy('./contactMessages/routes.js'));
app.route('/banners', lazy('./banners/routes.js'));
app.route('/countries', lazy('./countries/routes.js'));
app.route('/upload', lazy('./upload/routes.js'));
app.route('/emails', lazy('./emails/routes.js'));
app.route('/payments', lazy('./payments/routes.js'));
app.route('/receipts', lazy('./receipts/routes.js'));

// --- Authenticated / heavier routes (lazy loaded) ---
app.route('/auth', lazy('./auth/routes.js'));
app.route('/properties', lazy('./properties/routes.js'));
app.route('/rooms', lazy('./rooms/routes.js'));
app.route('/chats', lazy('./chats/routes.js'));
app.route('/users', lazy('./users/routes.js'));
app.route('/bookings', lazy('./bookings/routes.js'));

// --- Health Check (keep eager, small and hot) ---
app.get('/', (c) => c.text('✅ Hono API ready'));

export default app;
