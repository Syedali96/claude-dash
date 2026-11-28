import { readFileSync } from "node:fs";
import { defineConfig, type Plugin, type ProxyOptions } from "vite";

// While testing (npm run dev), calls to /api, /setup and /auth go to the local
// server (npm run server) and get your access token added here, so the phone
// page needs no token. Deployed builds call your Worker URL directly instead.
function devVar(name: string): string {
  try {
    return new RegExp(`^${name}=(.*)$`, "m").exec(readFileSync(".dev.vars", "utf8"))?.[1]?.trim() ?? "";
  } catch {
    return "";
  }
}
const devToken = () => devVar("APP_TOKEN");

// Use the deployed server when there is one (real data); otherwise `npm run server`.
// LOCAL_API=1 npm run dev forces the local server, to test Worker changes before deploying.
const target = (!process.env.LOCAL_API && devVar("SERVER_URL")) || "http://127.0.0.1:8787";
const withToken: ProxyOptions = {
  target,
  changeOrigin: true,
  configure: (proxy) =>
    proxy.on("proxyReq", (req) => req.setHeader("Authorization", `Bearer ${devToken()}`)),
};

// Touch test (?touchtest): the page posts each raw glasses event here so it shows in the dev server log.
const touchLog: Plugin = {
  name: "touch-log",
  configureServer(server) {
    server.middlewares.use("/__touchlog", (req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        console.log(`[touchtest] ${new Date().toISOString()} ${body}`);
        res.statusCode = 204;
        res.end();
      });
    });
  },
};

export default defineConfig(({ command }) => ({
  plugins: [touchLog],
  // Packaged builds (npm run pack) talk to your deployed server directly, so the
  // address and token are built in; settings on the phone can still override them.
  define: {
    __BUILD_SERVER__: JSON.stringify(command === "build" ? devVar("SERVER_URL") : ""),
    // Never baked into the package (it's uploaded to Even Hub). Paste it once in the phone settings.
    __BUILD_TOKEN__: JSON.stringify(""),
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: { "/api": withToken, "/setup": withToken, "/auth": withToken },
  },
  build: { target: "es2022" },
}));
