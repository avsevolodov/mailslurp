import { createApp } from "../src/server.js";

const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be an integer between 1 and 65535.");
}
const configured = Boolean(process.env.MAILSLURP_API_KEY);
const server = createApp({ configured });
server.listen(port, host, () => {
  console.log(`MailSlurp Preview Lab: http://${host}:${port}`);
  if (!configured) console.warn("MAILSLURP_API_KEY is missing. Set it to enable real previews.");
});
