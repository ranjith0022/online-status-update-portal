const API_BASE = import.meta.env.VITE_API_BASE || "http://localhost:4000";

async function api(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });

  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const message = (data && data.error) || res.statusText;
    throw new Error(message);
  }
  return data;
}

export { api };
