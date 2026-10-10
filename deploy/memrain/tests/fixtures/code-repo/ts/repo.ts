export interface Row {
  id: string;
}

export interface Db {
  execute(sql: string, row: Row): void;
}

export class Repo {
  constructor(private readonly db: Db) {}

  save(row: Row): void {
    this.db.execute("INSERT INTO rows VALUES ($1)", row);
  }
}
