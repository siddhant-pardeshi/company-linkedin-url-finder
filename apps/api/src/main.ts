import path from "node:path";
import { ConfigError, loadConfig } from "./config.js";
import { loadEnvFile } from "./dotenv.js";
import { createLogger } from "./logger.js";
import { createResolverServer } from "./server.js";

function main(): void {
  // Local convenience only; real deployments use injected environment variables.
  loadEnvFile(process.env["ENV_FILE"] ?? path.resolve(process.cwd(), ".env"));

  let config;
  try {
    config = loadConfig();
  } catch (error) {
    const message = error instanceof ConfigError ? error.message : "Invalid resolver configuration";
    process.stderr.write(`company-page-finder resolver: ${message}\n`);
    process.exitCode = 1;
    return;
  }

  const logger = createLogger(config.logLevel);
  const { server } = createResolverServer(config, { logger });

  server.on("error", (error) => {
    logger.error("server_error", { errorName: error.name });
    process.exitCode = 1;
  });

  server.listen(config.port, config.host, () => {
    logger.info("resolver_started", {
      host: config.host,
      port: config.port,
      provider: config.provider,
      version: config.version,
      tokens: config.accessTokenHashes.length,
      cacheTtlMs: config.cacheTtlMs,
      rateLimitPerMinute: config.rateLimitPerMinute,
      concurrency: config.providerConcurrency,
      environment: config.env,
    });
    if (config.provider === "mock") {
      logger.warn("mock_provider_active", { note: "Fixture data only. Do not use for production lookups." });
    }
  });

  const shutdown = (signal: string): void => {
    logger.info("shutdown_requested", { signal });
    server.close(() => {
      logger.info("shutdown_complete");
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 5000).unref();
  };

  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

main();
