const { spawn, spawnSync } = require("child_process");
const http = require("http");
const net = require("net");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");
const explicitPort = process.env.LANTERN_GARAGE_TEST_PORT || process.env.LANTERN_GARAGE_PORT;
const explicitBaseUrl = process.env.LANTERN_GARAGE_TEST_BASE_URL;
let port = Number(explicitPort || 4177);
let baseUrl = explicitBaseUrl || `http://127.0.0.1:${port}`;
const node = process.execPath;
const playwrightCli = path.join(repoRoot, "node_modules", "@playwright", "test", "cli.js");

const allCommands = {
  api: [node, ["tests/test_dream_journal_api.js"]],
  chat: [node, ["tests/test_dream_journal_chat.js"]],
  multiturn: [node, ["tests/test_dream_chat_multiturns.js"]],
  keystone: [node, ["tests/test_dream_journal_keystone.js"]],
  cache: [node, ["tests/test_provider_cache.js"]],
  validate: [node, ["apps/lantern-garage/validate.js"]],
  ui: [node, [playwrightCli, "test", "tests/test_dream_journal_ui.spec.js"]],
  "ui:headed": [node, [playwrightCli, "test", "tests/test_dream_journal_ui.spec.js", "--headed"]],
  "dream-chat-ui": [node, [playwrightCli, "test", "tests/test_dream_chat_ux.spec.js"]],
};

function selectedCommands() {
  const requested = process.argv.slice(2);
  const names = requested.length ? requested : ["api", "chat", "multiturn", "keystone", "cache", "ui"];
  for (const name of names) {
    if (!allCommands[name]) {
      throw new Error(`Unknown test target "${name}". Use api, chat, multiturn, keystone, cache, validate, ui, ui:headed, or dream-chat-ui.`);
    }
  }
  return names;
}

function getHealth() {
  return new Promise((resolve) => {
    const req = http.get(`${baseUrl}/api/health`, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.setTimeout(1000, () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
  });
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

async function waitForHealth(timeoutMs = 12000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await getHealth()) return true;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return false;
}

function run(command, args, label) {
  return new Promise((resolve, reject) => {
    console.log(`\n> ${label}`);
    const child = spawn(command, args, {
      cwd: repoRoot,
      stdio: "inherit",
      env: {
        ...process.env,
        LANTERN_GARAGE_PORT: String(port),
        LANTERN_GARAGE_TEST_BASE_URL: baseUrl,
      },
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${label} failed with exit code ${code}`));
    });
  });
}

function startServer() {
  const child = spawn(node, ["apps/lantern-garage/server.js"], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      LANTERN_GARAGE_PORT: String(port),
      LANTERN_GARAGE_HOST: "127.0.0.1",
    },
  });
  child.stdout.on("data", (chunk) => {
    if (process.env.LANTERN_TEST_VERBOSE) process.stdout.write(chunk);
  });
  child.stderr.on("data", (chunk) => {
    process.stderr.write(chunk);
  });
  return child;
}

function stopServer(child) {
  if (!child || child.killed) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
  } else {
    child.kill("SIGTERM");
  }
}

(async () => {
  const names = selectedCommands();
  let server = null;
  const canReuseExisting = Boolean(explicitBaseUrl || explicitPort);
  let alreadyRunning = await getHealth();

  if (!alreadyRunning && !canReuseExisting) {
    port = await findFreePort();
    baseUrl = `http://127.0.0.1:${port}`;
  }

  if (!alreadyRunning) {
    server = startServer();
    if (!(await waitForHealth())) {
      stopServer(server);
      throw new Error(`Lantern Garage did not become healthy at ${baseUrl}/api/health`);
    }
  }

  try {
    for (const name of names) {
      const [command, args] = allCommands[name];
      await run(command, args, `npm test:${name}`);
    }
  } finally {
    if (server) stopServer(server);
  }
})().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
