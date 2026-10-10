import type { Repo, Row } from "./repo";

export function legacyImport(repo: Repo, row: Row): void {
  repo.save(row);
}
