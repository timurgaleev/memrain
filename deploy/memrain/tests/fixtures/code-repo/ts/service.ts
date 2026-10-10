import type { Repo, Row } from "./repo";

export class Service {
  constructor(private readonly repo: Repo) {}

  save(row: Row): void {
    this.repo.save(row);
  }

  lookup(cache: Map<string, Row>, key: string): Row | undefined {
    return cache.get(key);
  }
}
