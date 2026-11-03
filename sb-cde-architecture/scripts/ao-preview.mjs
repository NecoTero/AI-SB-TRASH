import { spawn } from "node:child_process";
import net from "node:net";

const host = "127.0.0.1";
const webPort = Number(process.env.PORT ?? 5173);

if (!Number.isInteger(webPort) || webPort < 1 || webPort > 65535) {
  throw new Error(`Invalid preview port: ${process.env.PORT}`);
}

async function isAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen({ host, port }, () => server.close(() => resolve(true)));
  });
}

async function findApiPort(start) {
  for (let port = start; port <= Math.min(start + 100, 65535); port += 1) {
    if (port !== webPort && (await isAvailable(port))) return port;
  }
  throw new Error("No free API port found for the preview session");
}

const apiPort = await findApiPort(Math.min(webPort + 1, 65535));
const env = { ...process.env, API_PORT: String(apiPort), HOST: host, PORT: String(webPort) };
function spawnNpm(args) {
  if (process.platform === "win32") {
    const command = process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe";
    return spawn(command, ["/d", "/s", "/c", "npm.cmd", ...args], { env, stdio: "inherit" });
  }
  return spawn("npm", args, { env, stdio: "inherit" });
}

const children = [
  spawnNpm(["run", "dev:api"]),
  spawnNpm(["run", "dev:web", "--", "--host", host, "--port", String(webPort), "--strictPort"]),
];

let stopping = false;
function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill();
  process.exitCode = exitCode;
}

for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => stop(0));
for (const child of children) {
  child.on("error", (error) => {
    console.error(error);
    stop(1);
  });
  child.on("exit", (code, signal) => {
    if (!stopping) {
      console.error(`Preview child exited (${signal ?? code ?? "unknown"})`);
      stop(code ?? 1);
    }
  });
}

