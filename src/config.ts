const DEFAULT_API_URL = "https://skillhub.dev";

export function getApiUrl(): string {
  const configured = process.env.SKILLHUB_API_URL;
  if (!configured) return DEFAULT_API_URL;
  return configured.endsWith("/") ? configured.slice(0, -1) : configured;
}
