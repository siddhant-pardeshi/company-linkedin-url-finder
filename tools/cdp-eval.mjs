const CDP = process.env.CDP_URL ?? "http://127.0.0.1:9223";
const targetUrlPart = process.env.TARGET ?? "workspace.html";
const expression = process.argv[2] ?? "1+1";

const targets = await (await fetch(`${CDP}/json/list`)).json();
const target = targets.find((entry) => entry.type === "page" && entry.url.includes(targetUrlPart));
if (!target) throw new Error("No matching page target");

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve, { once: true });
  ws.addEventListener("error", reject, { once: true });
});

let id = 0;
const pending = new Map();
ws.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
  }
});

const result = await new Promise((resolve) => {
  const requestId = ++id;
  pending.set(requestId, resolve);
  ws.send(
    JSON.stringify({
      id: requestId,
      method: "Runtime.evaluate",
      params: { expression, awaitPromise: true, returnByValue: true },
    }),
  );
});

console.log(JSON.stringify(result.result?.result?.value ?? result, null, 2));
ws.close();
