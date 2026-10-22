export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export async function api<T = unknown>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const res = await fetch(path, {
    credentials: 'include',
    ...init,
    headers,
  });

  if (!res.ok) {
    let message = res.statusText;
    try {
      const data = (await res.json()) as {
        message?: string | string[];
      };
      if (Array.isArray(data.message)) {
        message = data.message.join(', ');
      } else if (data.message) {
        message = data.message;
      }
    } catch {
      // ignore parse errors; fall back to statusText
    }
    throw new ApiError(message, res.status);
  }

  // Nest sends an empty 200 when a handler returns nothing, and 204 has no
  // body at all; neither is a failure.
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}
