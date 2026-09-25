export type RemoteMacProfile = {
  enabled: boolean;
  host: string;
  user: string;
  port: number;
  projectPath: string;
};

export const defaultRemoteMacProfile: RemoteMacProfile = {
  enabled: false,
  host: "",
  user: "",
  port: 22,
  projectPath: "",
};
