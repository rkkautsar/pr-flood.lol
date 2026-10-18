export type User = { id: number; login: string };
export type Job = {
  id: string;
  owner: number;
  quotaGranted?: boolean;
  connected?: boolean;
  scenario: string;
  version: string;
  stage?: string;
  mode?: "review" | "milestone";
  digest?: string;
  marker?: string;
  name: string;
  private: boolean;
  state:
    | "creating"
    | "connecting"
    | "seeding"
    | "ready"
    | "waiting-access"
    | "failed";
  attempts: number;
  repository?: number;
  installation?: number;
  url?: string;
  run?: string;
  createSent?: boolean;
  error?: string;
  createdAt: number;
  baseline?: string;
};
export type Login = {
  user: User;
  token: string;
  expires: number;
  csrf: string;
  origin: string;
};

export type OAuthState = {
  state: string;
  verifier: string;
  expires: number;
  origin: string;
};
