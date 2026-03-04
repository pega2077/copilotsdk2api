import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { CopilotClient, type ModelInfo } from "@github/copilot-sdk";

let sharedClient: CopilotClient | null = null;
let startPromise: Promise<void> | null = null;
let tempDirPromise: Promise<string> | null = null;

/**
 * Returns a temporary working directory for the Copilot process.
 * The directory is created inside the current working directory on first call
 * and reused for subsequent calls.
 */
export async function getTempDir(): Promise<string> {
  if (!tempDirPromise) {
    tempDirPromise = mkdtemp(join(process.cwd(), "copilot-tmp-")).catch((err: unknown) => {
      tempDirPromise = null;
      throw new Error(`Failed to create Copilot temporary directory: ${err instanceof Error ? err.message : String(err)}`);
    });
  }
  return tempDirPromise;
}

/**
 * Returns a shared CopilotClient instance, starting it on first use.
 * The GitHub token is read from the GITHUB_TOKEN, COPILOT_GITHUB_TOKEN,
 * or GH_TOKEN environment variables in that order.
 */
export async function getClient(): Promise<CopilotClient> {
  if (!sharedClient) {
    const githubToken =
      process.env["COPILOT_GITHUB_TOKEN"] ??
      process.env["GITHUB_TOKEN"] ??
      process.env["GH_TOKEN"];

    const cwd = await getTempDir();

    sharedClient = new CopilotClient({
      githubToken,
      cwd,
      autoRestart: true,
    });
  }

  if (!startPromise) {
    startPromise = sharedClient.start();
  }
  await startPromise;

  return sharedClient;
}

/**
 * Fetch all available Copilot models.
 */
export async function listModels(): Promise<ModelInfo[]> {
  const client = await getClient();
  return client.listModels();
}

/**
 * Shut down the shared client on process exit.
 */
export async function shutdown(): Promise<void> {
  if (sharedClient) {
    await sharedClient.stop();
    sharedClient = null;
    startPromise = null;
  }
  if (tempDirPromise) {
    const dir = await tempDirPromise.catch((err: unknown) => {
      console.error(`Copilot temporary directory cleanup skipped: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    });
    tempDirPromise = null;
    if (dir) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

/**
 * Returns the path to the bundled Copilot CLI entry point.
 */
function getCopilotCliPath(): string {
  let sdkUrl: string;
  try {
    sdkUrl = import.meta.resolve("@github/copilot/sdk");
  } catch {
    throw new Error(
      "Could not resolve the bundled Copilot CLI. Ensure @github/copilot is installed (it ships as a dependency of @github/copilot-sdk)."
    );
  }
  return join(dirname(dirname(fileURLToPath(sdkUrl))), "index.js");
}

/**
 * Checks Copilot authentication status on startup.
 * If an environment token is present the check is skipped.
 * Otherwise the shared client is started and `getAuthStatus()` is called.
 * When the CLI reports that it is not authenticated, the interactive
 * `copilot login` OAuth device-flow is launched so the user can sign in.
 * After a successful login the shared client is reset so that subsequent
 * calls to `getClient()` pick up the newly stored credentials.
 */
export async function ensureAuthenticated(): Promise<void> {
  // Use truthy check so that empty-string env vars are treated as absent.
  const hasEnvToken = Boolean(
    process.env["COPILOT_GITHUB_TOKEN"] ||
    process.env["GITHUB_TOKEN"] ||
    process.env["GH_TOKEN"]
  );

  if (hasEnvToken) {
    return;
  }

  // The shared client must be started to query authentication status –
  // there is no lighter-weight mechanism exposed by the SDK.
  const client = await getClient();
  const authStatus = await client.getAuthStatus();

  if (authStatus.isAuthenticated) {
    const who = authStatus.login ? ` as ${authStatus.login}` : "";
    console.log(`Authenticated${who} via ${authStatus.authType ?? "unknown"}`);
    return;
  }

  console.log("Not authenticated. Starting Copilot login...");

  await new Promise<void>((resolve, reject) => {
    const proc = spawn(process.execPath, [getCopilotCliPath(), "login"], {
      stdio: "inherit",
    });
    proc.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `Copilot login failed with exit code ${code}. ` +
            `Check your network connection and GitHub permissions, ` +
            `or run "copilot login" manually.`
          )
        );
      }
    });
    proc.on("error", reject);
  });

  // Reset the shared client so the next call to getClient() starts fresh
  // and picks up the newly stored credentials.
  await shutdown();
}
