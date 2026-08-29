const DEFAULT_API_URL = "https://ahood.vercel.app";

export function getApiUrl(): string {
  const configured = process.env.AHOOD_API_URL;
  if (!configured) return DEFAULT_API_URL;
  return configured.endsWith("/") ? configured.slice(0, -1) : configured;
}
