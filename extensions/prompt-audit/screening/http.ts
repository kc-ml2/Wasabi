export interface PostJsonOptions {
  apiKey?: string;
  timeoutMs: number;
  maxResponseBytes?: number;
  signal?: AbortSignal;
}

type HttpErrorCode = "configuration" | "timeout" | "network" | "status" | "response_size" | "invalid_json";

/** Deliberately contains no endpoint, request, response body, or credentials. */
export class HttpRequestError extends Error {
  readonly code: HttpErrorCode;
  readonly status?: number;
  constructor(code: HttpErrorCode, message: string, status?: number) {
    super(message);
    this.name = "HttpRequestError";
    this.code = code;
    this.status = status;
  }
}

/** One request, with a total deadline covering connection and response delivery. */
export async function postJson(url: string, body: unknown, options: PostJsonOptions): Promise<unknown> {
  const maxBytes = options.maxResponseBytes ?? 262_144;
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0 ||
      !Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new HttpRequestError("configuration", "Invalid HTTP timeout or response limit.");
  }
  try {
    const endpoint = new URL(url);
    if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password) throw new Error();
  } catch {
    throw new HttpRequestError("configuration", "Invalid HTTP endpoint.");
  }
  let payload: string;
  try {
    const serialized = JSON.stringify(body);
    if (serialized === undefined) throw new Error();
    payload = serialized;
  } catch {
    throw new HttpRequestError("configuration", "Request is not valid JSON data.");
  }

  const controller = new AbortController();
  options.signal?.throwIfAborted();
  let rejectCancelled: (error: unknown) => void = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => { rejectCancelled = reject; });
  const onAbort = () => {
    controller.abort();
    rejectCancelled(new Error("HTTP request cancelled."));
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new HttpRequestError("timeout", "HTTP request timed out."));
    }, options.timeoutMs);
  });

  const request = async (): Promise<unknown> => {
    const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json" };
    if (options.apiKey) headers.Authorization = `Bearer ${options.apiKey}`;
    const response = await fetch(url, {
      method: "POST", headers, body: payload, signal: controller.signal, redirect: "error",
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw new HttpRequestError("status", `HTTP request failed (status ${response.status}).`, response.status);
    }
    const declaredLength = response.headers.get("content-length");
    if (declaredLength !== null && Number(declaredLength) > maxBytes) {
      void response.body?.cancel().catch(() => {});
      throw new HttpRequestError("response_size", "HTTP response exceeded the size limit.");
    }
    if (!response.body) throw new HttpRequestError("invalid_json", "HTTP response was not valid JSON.");

    const reader = response.body.getReader();
    const cancel = () => { void reader.cancel().catch(() => {}); };
    controller.signal.addEventListener("abort", cancel, { once: true });
    let bytes = 0;
    let text = "";
    const decoder = new TextDecoder("utf-8", { fatal: true });
    try {
      if (controller.signal.aborted) cancel();
      while (true) {
        controller.signal.throwIfAborted();
        const chunk = await reader.read();
        controller.signal.throwIfAborted();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > maxBytes) {
          cancel();
          throw new HttpRequestError("response_size", "HTTP response exceeded the size limit.");
        }
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
    } finally {
      controller.signal.removeEventListener("abort", cancel);
      reader.releaseLock();
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new HttpRequestError("invalid_json", "HTTP response was not valid JSON.");
    }
  };

  try {
    return await Promise.race([request(), deadline, cancelled]);
  } catch (error) {
    if (timedOut) throw new HttpRequestError("timeout", "HTTP request timed out.");
    if (error instanceof HttpRequestError) throw error;
    throw new HttpRequestError("network", "HTTP request could not be completed.");
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    clearTimeout(timer);
    controller.abort();
  }
}
