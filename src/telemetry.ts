export type Properties = Record<string, string>;

/**
 * What the service reports. Every call carries a route, a status, a duration, or a short enumerated label; nothing
 * that comes from a template, its data, a filename or an error message is ever passed in.
 */
export interface Telemetry {
  request(route: string, status: number, durationMs: number): void;
  exception(error: Error, properties?: Properties): void;
  event(name: string, properties?: Properties): void;
  metric(name: string, value: number, properties?: Properties): void;
}

export const noTelemetry: Telemetry = {
  request: () => {},
  exception: () => {},
  event: () => {},
  metric: () => {}
};

/** The stack frames of an error without its message, which can quote template or data text. */
export const scrubbed = (error: Error): Error => {
  const safe = new Error(error.name);
  safe.name = error.name;
  safe.stack = [error.name, ...(error.stack ?? "").split("\n").filter((line) => /^\s+at /.test(line))].join("\n");
  return safe;
};

/**
 * Starts Application Insights when a connection string is set, and otherwise returns a telemetry that does nothing.
 *
 * Call this before anything else is imported: Azure Monitor disables OpenTelemetry loggers and transports created
 * before it initialises. Auto-collected requests and console capture are off, so that route names stay bounded and
 * nothing the service prints reaches Application Insights; requests are reported by the handler instead.
 */
export const startTelemetry = async (connectionString: string | undefined, roleName = "dtsse-doc-render"): Promise<Telemetry> => {
  if (!connectionString) {
    return noTelemetry;
  }
  try {
    process.env.APPLICATIONINSIGHTS_ROLE_NAME = roleName;
    const insights = await import("applicationinsights");
    insights
      .setup(connectionString)
      .setAutoCollectRequests(false)
      .setAutoCollectDependencies(false)
      .setAutoCollectConsole(false, false)
      .setAutoCollectPerformance(true, true)
      .setAutoCollectExceptions(true)
      .setUseDiskRetryCaching(false)
      .start();
    const client = insights.defaultClient;
    return {
      request: (route, status, durationMs) =>
        client.trackRequest({ name: route, url: route, duration: durationMs, resultCode: String(status), success: status < 500 }),
      exception: (error, properties) => client.trackException({ exception: scrubbed(error), properties }),
      event: (name, properties) => client.trackEvent({ name, properties }),
      metric: (name, value, properties) => client.trackMetric({ name, value, properties })
    };
  } catch (error) {
    console.warn(`could not start Application Insights: ${error instanceof Error ? error.name : "unknown error"}`);
    return noTelemetry;
  }
};
