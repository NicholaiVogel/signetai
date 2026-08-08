export {};

process.env.SIGNET_TELEMETRY_ENV ||= "dev";

await import("./cli");
