// Tiny upstream that echoes what the broker forwarded.
// Run on port 9999. The broker's "echo" provider forwards there by default.
import { createServer } from "node:http";

const PORT = Number(process.env.PORT ?? 9999);

createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: body || null,
      }),
    );
  });
}).listen(PORT, "127.0.0.1", () => {
  console.log(`echo-upstream listening on http://127.0.0.1:${PORT}`);
});
