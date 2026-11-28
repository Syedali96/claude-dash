// Writes wrangler.local.jsonc and app.local.json (both git-ignored) from the committed
// templates, filling in your own values from .dev.vars:
//   KV_NAMESPACE_ID -> wrangler.jsonc "kv_namespaces" id
//   SERVER_URL      -> app.json "network" whitelist (your Worker's address)
//   PACKAGE_ID      -> app.json "package_id" (your app's id on Even Hub)
// so your account ids and Worker address never need to be committed.
import { readFileSync, writeFileSync } from "node:fs";

let vars = "";
try {
  vars = readFileSync(".dev.vars", "utf8");
} catch {
  console.error("No .dev.vars yet: copy .dev.vars.example to .dev.vars and fill it in (see README).");
  process.exit(1);
}
const get = (name) => new RegExp(`^${name}=(.*)$`, "m").exec(vars)?.[1]?.trim().replace(/^["']|["']$/g, "") ?? "";

const kv = get("KV_NAMESPACE_ID");
const wrangler = readFileSync("wrangler.jsonc", "utf8");
if (kv) writeFileSync("wrangler.local.jsonc", wrangler.replace("YOUR_KV_NAMESPACE_ID", kv));
else console.warn("KV_NAMESPACE_ID is empty in .dev.vars: run `npx wrangler kv namespace create TOKENS` and paste the id.");

const server = get("SERVER_URL").replace(/\/+$/, "");
const app = readFileSync("app.json", "utf8");
const pkg = get("PACKAGE_ID");
writeFileSync(
  "app.local.json",
  app.replace("https://YOUR-WORKER.workers.dev", server || "https://YOUR-WORKER.workers.dev").replace("com.example.claudedash", pkg || "com.example.claudedash"),
);
if (!server) console.warn("SERVER_URL is empty in .dev.vars: the packaged app won't be allowed to reach your Worker yet.");
