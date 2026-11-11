import fs from "node:fs";
import path from "node:path";

const dir = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "docs", "queue");
const read = (f) => fs.readFileSync(path.join(dir, f), "utf8");

let html = read("index.html");
const css = read("styles.css");
const js = read("hosted.js");
const icon = fs.readFileSync(path.join(dir, "icon-512.png")).toString("base64");
const icon192 = fs.readFileSync(path.join(dir, "icon-192.png")).toString("base64");

const config = `window.QUEUE_CONFIG = { url: "__SUPABASE_URL__", anonKey: "__SUPABASE_ANON_KEY__" };\n`;

html = html
  .replace('<link rel="stylesheet" href="styles.css">', "<style>\n" + css + "\n</style>")
  .replace(/<link rel="manifest"[^>]*>\n?/, "")
  .replace('<link rel="apple-touch-icon" href="icon-192.png">',
    '<link rel="apple-touch-icon" href="data:image/png;base64,' + icon192 + '">')
  .replace('<title>Queue</title>', '<title>Sai Agents</title>')
  .replace('<span class="logo"></span>',
    '<img class="logo" alt="" src="data:image/png;base64,' + icon + '">')
  .replace('<script src="hosted.js"></script>',
    "<script>" + config + "window.QUEUE_ICON = 'data:image/png;base64," + icon + "';</script>\n<script>\n" + js + "\n</script>");

const out = path.join(dir, "..", "..", "hosted", "dist");
fs.mkdirSync(out, { recursive: true });
const file = path.join(out, "sai-agents.html");
fs.writeFileSync(file, html);
console.log(file, (fs.statSync(file).size / 1024).toFixed(1) + " KB");
