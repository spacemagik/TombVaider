import { defineConfig } from 'vite';

export default defineConfig({
  optimizeDeps: {
    // Spark’s WASM glue can include `data:application/wasm;base64,...` URLs.
    // Vite’s dep pre-bundling can rewrite those into giant `/node_modules/.vite/deps/data:...`
    // requests, which then fail (often as 431 / request too large). Excluding Spark keeps its
    // module code un-prebundled so the browser can handle the `data:` URL correctly.
    exclude: ['@sparkjsdev/spark'],
  },
  plugins: [
    // Work around Vite rewriting Spark's inline `data:application/wasm;base64,...` URL into a
    // gigantic dev-server path like `/node_modules/@sparkjsdev/spark/dist/data:application/...`,
    // which then fails with 431 (request header fields too large) before WASM can compile.
    //
    // We rewrite the WASM "URL object" into a plain string data URL so `fetch()` stays local
    // (no HTTP request) and wasm-bindgen can initialize normally.
    {
      name: 'spark-inline-wasm-dataurl-fix',
      enforce: 'pre',
      transform(code, id) {
        // Vite's `id` can be an absolute path, a /@fs/ path, or include query params.
        // We match loosely so it still works across OSes and dev/prod modes.
        if (!id.includes('@sparkjsdev/spark')) return;
        if (!id.includes('spark.module.js')) return;
        if (!code.includes('data:application/wasm;base64,')) return;

        // Replace: module_or_path = new URL("data:application/wasm;base64,...");
        // With:    module_or_path = "data:application/wasm;base64,...";
        const next = code.replace(
          /module_or_path\s*=\s*new URL\("data:application\/wasm;base64,([^"]+)"\);/g,
          'module_or_path = "data:application/wasm;base64,$1";'
        );
        return next === code ? null : next;
      },
    },
    {
      name: 'strip-cookie-header',
      configureServer(server) {
        server.middlewares.use((req, _res, next) => {
          // Prevent oversized Cookie headers from causing 431 responses in dev.
          // (This can happen if you have huge localhost cookies from other tools.)
          if (req?.headers?.cookie) delete req.headers.cookie;
          next();
        });
      },
    },
  ],
  server: {
    host: '127.0.0.1',
    port: 5180,
    strictPort: true,
    open: false,
  },
});
