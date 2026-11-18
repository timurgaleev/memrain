// Stands in for the operator's tool client inside the member build (see
// vite.app.config.ts). A member has no operator tool route: the Ask page's
// example questions, the only tool call it makes, are simply left out.
export async function tool(name: string): Promise<unknown> {
  throw new Error(`${name} is not available in the member app`);
}
