import { simpleGit, type SimpleGit, type DefaultLogFields } from 'simple-git';

export interface CorpGit {
  raw: SimpleGit;
  init(): Promise<void>;
  commitAll(message: string): Promise<void>;
  log(n?: number): Promise<{ hash: string; message: string; date: string }[]>;
  diff(): Promise<string>;
  status(): Promise<{ modified: string[]; created: string[]; deleted: string[] }>;
}

export function corpGit(corpPath: string): CorpGit {
  const git = simpleGit(corpPath);

  return {
    raw: git,

    async init() {
      await git.init();
      await git.addConfig('user.name', 'AgentCorp');
      await git.addConfig('user.email', 'agentcorp@local');
    },

    async commitAll(message: string) {
      await git.add('.');
      await git.commit(message);
    },

    async log(n = 20) {
      const result = await git.log({ maxCount: n });
      return result.all.map((entry: DefaultLogFields) => ({
        hash: entry.hash,
        message: entry.message,
        date: entry.date,
      }));
    },

    async diff() {
      return git.diff();
    },

    async status() {
      const result = await git.status();
      return {
        modified: result.modified,
        created: result.created,
        deleted: result.deleted,
      };
    },
  };
}
