/**
 * Simple request/event logger.
 *
 * Logging is enabled when any of the following is true:
 *   - The LOG_ENABLED environment variable is set to a truthy value ("1", "true", etc.)
 *   - NODE_ENV is "development" (the default when running `npm run dev`)
 *
 * Logging can be explicitly disabled by setting LOG_ENABLED=false (or "0").
 */
export function isLoggingEnabled(): boolean {
  const val = process.env["LOG_ENABLED"];
  if (val !== undefined && val !== "") {
    return val.toLowerCase() !== "false" && val !== "0";
  }
  // Default: enabled in development mode.
  return process.env["NODE_ENV"] === "development";
}

export function log(message: string): void {
  if (isLoggingEnabled()) {
    console.log(`[${new Date().toISOString()}] ${message}`);
  }
}
