export interface Config {
  projectId: string;
  projectNumber: string;
  geminiApiKey: string;
  geminiModel: string;
  oauthClientId: string;
  oauthClientSecret: string;
  apiSecret: string;
  userEmail: string;
  logOnly: boolean;
}

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): Config {
  const req = (k: string): string => {
    const v = env[k];
    if (!v) throw new Error(`missing env var ${k}`);
    return v;
  };
  return {
    projectId: req("GCP_PROJECT_ID"),
    projectNumber: req("GCP_PROJECT_NUMBER"),
    geminiApiKey: req("GEMINI_API_KEY"),
    geminiModel: env.GEMINI_MODEL ?? "gemini-2.5-flash",
    oauthClientId: req("OAUTH_CLIENT_ID"),
    oauthClientSecret: req("OAUTH_CLIENT_SECRET"),
    apiSecret: req("API_SECRET"),
    userEmail: req("USER_EMAIL"),
    logOnly: env.LOG_ONLY === "true",
  };
}
