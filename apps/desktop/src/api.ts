export class ApiError extends Error {
  constructor(public code: string, message: string, public details?: Record<string, unknown>) {
    super(message);
  }
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: { ...(options.body ? { "content-type": "application/json" } : {}), ...options.headers }
  });
  const result = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new ApiError(String(result.code ?? "API_ERROR"), String(result.message ?? "Request failed"), result.details as Record<string, unknown> | undefined);
  return result as T;
}

export function post<T>(path: string, body?: unknown): Promise<T> {
  return api(path, { method: "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

export function patch<T>(path: string, body: unknown): Promise<T> {
  return api(path, { method: "PATCH", body: JSON.stringify(body) });
}

export function put<T>(path: string, body: unknown): Promise<T> {
  return api(path, { method: "PUT", body: JSON.stringify(body) });
}

export function remove<T>(path: string): Promise<T> { return api(path, { method: "DELETE" }); }
