import { clearCredentials } from "../credentials.js";

export async function logout(): Promise<void> {
  clearCredentials();
  console.log("Logged out.");
}
