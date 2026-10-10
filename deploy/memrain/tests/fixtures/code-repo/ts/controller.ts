import type { Service } from "./service";
import type { Row } from "./repo";

export function handleCreate(service: Service, row: Row): void {
  service.save(row);
}
