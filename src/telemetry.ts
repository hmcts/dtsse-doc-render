export type Properties = Record<string, string>;

export interface RequestReport {
  /** GET, POST or _OTHER, so the method of an unexpected request is never echoed. */
  method: string;
  /** A route from the routing table, or "unmatched"; never the path the client sent. */
  route: string;
  status: number;
  durationMs: number;
  success: boolean;
}

/**
 * What the service reports. Every call carries a route, a status, a duration, or a short enumerated label; nothing
 * that comes from a template, its data, a filename or an error message is ever passed in.
 */
export interface Telemetry {
  request(report: RequestReport): void;
  exception(error: Error, properties?: Properties): void;
  event(name: string, properties?: Properties): void;
  metric(name: string, value: number, properties?: Properties): void;
  /** Sends whatever is queued, resolving when it has gone or the timeout passes. */
  flush(timeoutMs?: number): Promise<void>;
}

export const noTelemetry: Telemetry = {
  request: () => {},
  exception: () => {},
  event: () => {},
  metric: () => {},
  flush: async () => {}
};

/** The stack frames of an error without its message, which can quote template or data text. */
export const scrubbed = (error: Error): Error => {
  const safe = new Error(error.name);
  safe.name = error.name;
  safe.stack = [error.name, ...(error.stack ?? "").split("\n").filter((line) => /^\s+at /.test(line))].join("\n");
  return safe;
};

const DEFAULT_FLUSH_TIMEOUT_MS = 5000;

const withTimeout = async (work: Promise<unknown>, timeoutMs: number): Promise<void> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([work, new Promise((resolve) => (timer = setTimeout(resolve, timeoutMs)))]);
  } catch {
    // Losing telemetry on the way out must not stop the process leaving.
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Takes over uncaught exceptions and unhandled rejections so that they reach Application Insights without their
 * messages, which the library's own collection would send. The process then dies as it would without a handler: the
 * error is printed and the exit code is 1. Returns a function that removes the handlers.
 */
export const installCrashHandlers = (telemetry: Telemetry, exit: (code: number) => void = process.exit): (() => void) => {
  let crashing = false;
  const crash = (error: unknown): void => {
    if (crashing) {
      return;
    }
    crashing = true;
    const failure = error instanceof Error ? error : new Error("non-error thrown");
    telemetry.exception(failure, { fatal: "true" });
    console.error(error);
    void telemetry
      .flush()
      .catch(() => undefined)
      .finally(() => exit(1));
  };
  process.on("uncaughtException", crash);
  process.on("unhandledRejection", crash);
  return () => {
    process.off("uncaughtException", crash);
    process.off("unhandledRejection", crash);
  };
};

/**
 * Starts Application Insights when a connection string is set, and otherwise returns a telemetry that does nothing.
 *
 * Auto-collected requests, console capture and exceptions are off, so that route names stay bounded and nothing the
 * service prints or throws reaches Application Insights unscrubbed; requests are reported by the handler instead.
 * The cloud role is the OpenTelemetry service name: `OTEL_SERVICE_NAME` when the chart sets it, so that preview and
 * staging releases are told apart, and "dtsse-doc-render" otherwise.
 */
export const startTelemetry = async (connectionString: string | undefined): Promise<Telemetry> => {
  if (!connectionString) {
    return noTelemetry;
  }
  try {
    process.env.OTEL_SERVICE_NAME ||= "dtsse-doc-render";
    const insights = await import("applicationinsights");
    insights
      .setup(connectionString)
      .setAutoCollectRequests(false)
      .setAutoCollectDependencies(false)
      .setAutoCollectConsole(false, false)
      .setAutoCollectPerformance(true, false)
      .setAutoCollectExceptions(false)
      .setUseDiskRetryCaching(false)
      .start();
    const client = insights.defaultClient;
    const telemetry: Telemetry = {
      request: ({ method, route, status, durationMs, success }) =>
        client.trackRequest({
          name: `${method} ${route}`,
          url: route,
          duration: durationMs,
          resultCode: String(status),
          success,
          properties: { "http.method": method, "http.route": route }
        }),
      exception: (error, properties) => client.trackException({ exception: scrubbed(error), properties }),
      event: (name, properties) => client.trackEvent({ name, properties }),
      metric: (name, value, properties) => client.trackMetric({ name, value, properties }),
      flush: (timeoutMs = DEFAULT_FLUSH_TIMEOUT_MS) => withTimeout(client.flush(), timeoutMs)
    };
    installCrashHandlers(telemetry);
    return telemetry;
  } catch (error) {
    console.warn(`could not start Application Insights: ${error instanceof Error ? error.name : "unknown error"}`);
    return noTelemetry;
  }
};
