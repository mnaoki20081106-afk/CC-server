const envBase = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, "");
export const API_BASE =
  envBase || (location.hostname === "localhost" ? "http://localhost:8787" : "");

const SESSION_KEY = "cc_session";

export class ApiError extends Error {
  status: number;
  code: string | null;
  payload: Record<string, unknown>;

  constructor(message: string, status: number, payload: Record<string, unknown> = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = typeof payload.error === "string" ? payload.error : null;
    this.payload = payload;
  }
}

function readStoredSession(): string | null {
  try {
    return localStorage.getItem(SESSION_KEY);
  } catch {
    return null;
  }
}

function storeSession(token: string): void {
  try {
    localStorage.setItem(SESSION_KEY, token);
  } catch {
    // Some privacy modes can deny persistent storage; session just won't persist.
  }
}

export function bootstrapSession(): string | null {
  return readStoredSession();
}

export function currentSession(): string | null {
  return readStoredSession();
}

export function clearSession(): void {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    // Ignore unavailable persistent storage.
  }
}

export async function login(password: string): Promise<void> {
  if (!API_BASE) throw new Error("API URL が未設定です");
  const response = await fetch(`${API_BASE}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password })
  });
  const payload = (await response.json().catch(() => ({}))) as { token?: string; error?: string };
  if (!response.ok || !payload.token) {
    throw new Error(payload.error || `HTTP ${response.status}`);
  }
  storeSession(payload.token);
}

export async function api<T>(path: string, init: RequestInit = {}, timeoutMs = 20_000): Promise<T> {
  if (!API_BASE) throw new Error("API URL が未設定です");
  const token = currentSession();
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");

  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);
  const externalSignal = init.signal;
  const abortFromExternal = () => controller.abort();
  externalSignal?.addEventListener("abort", abortFromExternal, { once: true });

  try {
    const response = await fetch(`${API_BASE}${path}`, { ...init, headers, signal: controller.signal });
    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      if (response.status === 401) clearSession();
      throw new ApiError(typeof payload.error === "string" ? payload.error : `HTTP ${response.status}`, response.status, payload);
    }
    return payload as T;
  } catch (reason) {
    if (controller.signal.aborted && !externalSignal?.aborted) {
      throw new Error(`APIの応答が${Math.round(timeoutMs / 1000)}秒以内に返りませんでした。再試行してください`);
    }
    throw reason;
  } finally {
    window.clearTimeout(timeoutId);
    externalSignal?.removeEventListener("abort", abortFromExternal);
  }
}
